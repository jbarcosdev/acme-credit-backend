import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AccessPolicy, type CurrentUserInfo } from '@acme/auth';
import {
  EVENT_TYPES,
  type CustodyLimitResponse,
  type LimitReductionResponse,
  type SettlementResponse,
} from '@acme/contracts';
import {
  AuditService,
  Clock,
  ConflictError,
  DomainError,
  fromMinor,
  IdempotencyService,
  NotFoundError,
  OutboxService,
  UnprocessableError,
  type IdempotentResult,
} from '@acme/nest-common';
import { BankRegistry } from '../../clients/banks/bank-registry.js';
import type { BankDepositEvent } from '../../clients/banks/bank-adapter.js';
import { CollateralTermsProvider } from '../../clients/terms/collateral-terms.provider.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../shared/prisma.service.js';
import type {
  CreateDepositDto,
  LimitReductionDto,
  OpenAccountDto,
  SettlementDto,
} from './dto/custody.dto.js';

type Tx = Prisma.TransactionClient;

interface AccountRow {
  id: string;
  owner_id: string;
  currency: string;
  held_amount: bigint;
  limit_version: number;
  status: 'OPEN' | 'CLOSED';
}

interface DepositRow {
  id: string;
  custody_account_id: string;
  bank_id: string;
  amount: bigint;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
}

export interface AccountView {
  id: string;
  ownerId: string;
  currency: string;
  heldAmount: number;
  cupo: number;
  limitVersion: number;
  status: string;
}

const BPS = 10_000n;

@Injectable()
export class CustodyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly policy: AccessPolicy,
    private readonly banks: BankRegistry,
    private readonly terms: CollateralTermsProvider,
    private readonly clock: Clock,
  ) {}

  async openAccount(
    user: CurrentUserInfo,
    key: string,
    dto: OpenAccountDto,
  ): Promise<IdempotentResult<AccountView>> {
    return this.run('open-account', user.userId, key, dto, async (tx) => {
      const account = await tx.custodyAccount.create({
        data: { ownerId: user.userId, currency: dto.currency ?? 'USD' },
      });
      await this.audit.record(tx, {
        action: 'custody.account.opened',
        entityType: 'custody_account',
        entityId: account.id,
      });
      return {
        statusCode: 201,
        body: await this.view(
          account.id,
          account.ownerId,
          account.currency,
          account.heldAmount,
          account.limitVersion,
          account.status,
        ),
      };
    });
  }

  async getAccount(user: CurrentUserInfo, id: string): Promise<AccountView> {
    const account = await this.prisma.custodyAccount.findUnique({
      where: { id },
    });
    if (!account)
      throw new NotFoundError(
        'CUSTODY_ACCOUNT_NOT_FOUND',
        'Custody account not found',
      );
    this.policy.assertCanAccessOwned(user, account.ownerId);
    return this.view(
      account.id,
      account.ownerId,
      account.currency,
      account.heldAmount,
      account.limitVersion,
      account.status,
    );
  }

  async createDeposit(
    user: CurrentUserInfo,
    accountId: string,
    key: string,
    dto: CreateDepositDto,
  ) {
    return this.run(
      `create-deposit:${accountId}`,
      user.userId,
      key,
      dto,
      async (tx) => {
        const account = await this.lock(tx, accountId);
        this.policy.assertCanAccessOwned(user, account.owner_id);
        if (account.status !== 'OPEN')
          throw new ConflictError(
            'ACCOUNT_CLOSED',
            'Custody account is closed',
          );
        if (!this.banks.has(dto.bankId))
          throw new NotFoundError(
            'BANK_NOT_FOUND',
            `Unknown bank ${dto.bankId}`,
          );

        const deposit = await tx.deposit.create({
          data: {
            custodyAccountId: accountId,
            bankId: dto.bankId,
            amount: BigInt(dto.amount),
            reference: `DEP-${randomBytes(12).toString('hex').toUpperCase()}`,
          },
        });
        await this.audit.record(tx, {
          action: 'custody.deposit.created',
          entityType: 'deposit',
          entityId: deposit.id,
          data: { amount: dto.amount, bankId: dto.bankId },
        });
        return {
          statusCode: 201,
          body: {
            depositId: deposit.id,
            bankId: deposit.bankId,
            reference: deposit.reference,
            amount: dto.amount,
            status: deposit.status,
          },
        };
      },
    );
  }

  async getLimit(accountId: string): Promise<CustodyLimitResponse> {
    const account = await this.prisma.custodyAccount.findUnique({
      where: { id: accountId },
    });
    if (!account)
      throw new NotFoundError(
        'CUSTODY_ACCOUNT_NOT_FOUND',
        'Custody account not found',
      );
    const { ratioBps } = await this.terms.getTerms();
    return {
      custodyAccountId: account.id,
      ownerId: account.ownerId,
      currency: account.currency,
      cupo: fromMinor(this.cupoOf(account.heldAmount, ratioBps)),
      version: account.limitVersion,
    };
  }

  async confirmDeposit(
    event: BankDepositEvent,
  ): Promise<IdempotentResult<{ status: string; depositId: string }>> {
    const request = {
      ...event,
      amount: event.amount.toString(),
      occurredAt: event.occurredAt.toISOString(),
    };
    try {
      return await this.run(
        'bank-webhook',
        event.bankId,
        event.eventId,
        request,
        async (tx) => {
          const deposits = await tx.$queryRaw<DepositRow[]>`
          SELECT id, custody_account_id, bank_id, amount, status FROM deposits
          WHERE reference = ${event.reference} FOR UPDATE`;
          const deposit = deposits[0];
          if (!deposit || deposit.bank_id !== event.bankId)
            throw new NotFoundError('DEPOSIT_NOT_FOUND', 'Deposit not found');
          if (deposit.status !== 'PENDING')
            throw new ConflictError(
              'DEPOSIT_NOT_PENDING',
              'Deposit is not pending',
            );
          if (deposit.amount !== event.amount)
            throw new UnprocessableError(
              'DEPOSIT_AMOUNT_MISMATCH',
              'Amount does not match the deposit',
            );

          const account = await this.lock(tx, deposit.custody_account_id);
          if (account.status !== 'OPEN')
            throw new ConflictError(
              'ACCOUNT_CLOSED',
              'Custody account is closed',
            );
          if (account.currency !== event.currency)
            throw new UnprocessableError(
              'CURRENCY_MISMATCH',
              'Currency does not match the account',
            );

          const held = account.held_amount + event.amount;
          const version = account.limit_version + 1;
          await tx.custodyAccount.update({
            where: { id: account.id },
            data: { heldAmount: held, limitVersion: version },
          });
          await tx.custodyMovement.create({
            data: {
              custodyAccountId: account.id,
              type: 'DEPOSIT',
              amount: event.amount,
              heldAfter: held,
              depositId: deposit.id,
            },
          });
          await tx.deposit.update({
            where: { id: deposit.id },
            data: { status: 'CONFIRMED', confirmedAt: this.clock.now() },
          });
          await this.audit.record(tx, {
            action: 'custody.deposit.confirmed',
            entityType: 'deposit',
            entityId: deposit.id,
            data: {
              bankId: event.bankId,
              eventId: event.eventId,
              amount: event.amount.toString(),
            },
          });
          await this.outbox.add(tx, EVENT_TYPES.custodyLimitChanged, {
            custodyAccountId: account.id,
            version,
          });
          return {
            statusCode: 200,
            body: { status: 'CONFIRMED', depositId: deposit.id },
          };
        },
      );
    } catch (error) {
      if (error instanceof DomainError) await this.auditRejection(event, error);
      throw error;
    }
  }

  async settle(
    caller: CurrentUserInfo,
    accountId: string,
    key: string,
    dto: SettlementDto,
  ): Promise<IdempotentResult<SettlementResponse>> {
    return this.run(
      `settle:${accountId}`,
      caller.userId,
      key,
      dto,
      async (tx) => {
        const account = await this.lock(tx, accountId);
        if (account.status !== 'OPEN')
          throw new ConflictError(
            'ACCOUNT_CLOSED',
            'Custody account is closed',
          );

        const requested = BigInt(dto.applyAmount);
        const applied =
          requested < account.held_amount ? requested : account.held_amount;
        const released = account.held_amount - applied;
        const version = account.limit_version + 1;

        if (applied > 0n) {
          await tx.custodyMovement.create({
            data: {
              custodyAccountId: account.id,
              type: 'APPLIED',
              amount: applied,
              heldAfter: released,
            },
          });
        }
        if (released > 0n) {
          await tx.custodyMovement.create({
            data: {
              custodyAccountId: account.id,
              type: 'RELEASE',
              amount: released,
              heldAfter: 0n,
            },
          });
        }
        await tx.custodyAccount.update({
          where: { id: account.id },
          data: { heldAmount: 0n, limitVersion: version, status: 'CLOSED' },
        });
        await this.audit.record(tx, {
          action: 'custody.account.settled',
          entityType: 'custody_account',
          entityId: account.id,
          data: { applied: applied.toString(), released: released.toString() },
        });
        await this.outbox.add(tx, EVENT_TYPES.custodyLimitChanged, {
          custodyAccountId: account.id,
          version,
        });
        return {
          statusCode: 200,
          body: { applied: fromMinor(applied), released: fromMinor(released) },
        };
      },
    );
  }

  async reduceLimit(
    caller: CurrentUserInfo,
    accountId: string,
    key: string,
    dto: LimitReductionDto,
  ): Promise<IdempotentResult<LimitReductionResponse>> {
    return this.run(
      `reduce-limit:${accountId}`,
      caller.userId,
      key,
      dto,
      async (tx) => {
        const { ratioBps } = await this.terms.getTerms();
        const account = await this.lock(tx, accountId);
        if (account.status !== 'OPEN')
          throw new ConflictError(
            'ACCOUNT_CLOSED',
            'Custody account is closed',
          );

        const ratio = BigInt(ratioBps);
        const required = (BigInt(dto.newCupo) * BPS + ratio - 1n) / ratio;
        if (required >= account.held_amount)
          throw new UnprocessableError(
            'NOT_A_REDUCTION',
            'The new limit does not reduce the current one',
          );

        const released = account.held_amount - required;
        const version = account.limit_version + 1;
        await tx.custodyMovement.create({
          data: {
            custodyAccountId: account.id,
            type: 'RELEASE',
            amount: released,
            heldAfter: required,
          },
        });
        await tx.custodyAccount.update({
          where: { id: account.id },
          data: { heldAmount: required, limitVersion: version },
        });
        await this.audit.record(tx, {
          action: 'custody.limit.reduced',
          entityType: 'custody_account',
          entityId: account.id,
          data: { newCupo: dto.newCupo, released: released.toString() },
        });
        await this.outbox.add(tx, EVENT_TYPES.custodyLimitChanged, {
          custodyAccountId: account.id,
          version,
        });
        return {
          statusCode: 200,
          body: {
            cupo: fromMinor(this.cupoOf(required, ratioBps)),
            version,
            released: fromMinor(released),
          },
        };
      },
    );
  }

  private run<T>(
    scope: string,
    ownerId: string,
    key: string,
    request: unknown,
    handler: (tx: Tx) => Promise<IdempotentResult<T>>,
  ) {
    return this.prisma.$transaction((tx) =>
      this.idempotency.execute(tx, { scope, ownerId, key, request }, () =>
        handler(tx),
      ),
    );
  }

  private async lock(tx: Tx, id: string): Promise<AccountRow> {
    const rows = await tx.$queryRaw<AccountRow[]>`
      SELECT id, owner_id, currency, held_amount, limit_version, status FROM custody_accounts
      WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows[0])
      throw new NotFoundError(
        'CUSTODY_ACCOUNT_NOT_FOUND',
        'Custody account not found',
      );
    return rows[0];
  }

  private cupoOf(held: bigint, ratioBps: number): bigint {
    return (held * BigInt(ratioBps)) / BPS;
  }

  private async view(
    id: string,
    ownerId: string,
    currency: string,
    held: bigint,
    limitVersion: number,
    status: string,
  ): Promise<AccountView> {
    const { ratioBps } = await this.terms.getTerms();
    return {
      id,
      ownerId,
      currency,
      heldAmount: fromMinor(held),
      cupo: fromMinor(this.cupoOf(held, ratioBps)),
      limitVersion,
      status,
    };
  }

  private async auditRejection(
    event: BankDepositEvent,
    error: DomainError,
  ): Promise<void> {
    try {
      await this.prisma.$transaction((tx) =>
        this.audit.record(tx, {
          action: 'custody.deposit.rejected',
          entityType: 'deposit',
          entityId: event.reference,
          data: {
            bankId: event.bankId,
            eventId: event.eventId,
            code: error.code,
          },
        }),
      );
    } catch {
      return;
    }
  }
}
