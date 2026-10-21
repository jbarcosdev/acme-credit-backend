import { Injectable } from '@nestjs/common';
import { AccessPolicy, type CurrentUserInfo } from '@acme/auth';
import {
  AuditService,
  Clock,
  ConflictError,
  fromMinor,
  IdempotencyService,
  NotFoundError,
  ServiceUnavailableError,
  toMinor,
  UnprocessableError,
  type IdempotentResult,
} from '@acme/nest-common';
import {
  CustodyClient,
  CustodyRejectedError,
  CustodyUnavailableError,
} from '../../clients/custody/custody.client.js';
import { LendingTermsProvider } from '../../clients/terms/lending-terms.provider.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../shared/prisma.service.js';
import {
  LimitsService,
  LimitUnavailableError,
} from '../limits/limits.service.js';
import {
  availableCredit,
  debtOf,
  payableOf,
  type AccountRow,
  type BucketName,
} from './account-types.js';
import type {
  AuthorizeDto,
  PaymentDto,
  RequestCardDto,
} from './dto/accounts.dto.js';
import { LedgerService } from './ledger.service.js';
import { PaymentHooks } from './payment-hooks.js';

type Tx = Prisma.TransactionClient;

export interface AccountView {
  id: string;
  ownerId: string;
  custodyAccountId: string;
  currency: string;
  status: string;
  cycleDay: number;
  balances: {
    principal: number;
    deferred: number;
    interest: number;
    fees: number;
    debt: number;
  };
  limit: { cupo: number | null; cap: number | null };
  availableCredit: number | null;
}

export interface AuthorizationResult {
  authorizationId: string | null;
  status: 'APPROVED' | 'DECLINED';
  reason?: string;
  availableCredit: number;
  installments?: number;
  installmentAprBps?: number;
}

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly policy: AccessPolicy,
    private readonly ledger: LedgerService,
    private readonly limits: LimitsService,
    private readonly custody: CustodyClient,
    private readonly terms: LendingTermsProvider,
    private readonly hooks: PaymentHooks,
    private readonly clock: Clock,
  ) {}

  async requestCard(
    user: CurrentUserInfo,
    key: string,
    dto: RequestCardDto,
  ): Promise<IdempotentResult<AccountView>> {
    const terms = await this.terms.getCurrent();
    if (!terms.cycleDays.includes(dto.cycleDay))
      throw new UnprocessableError(
        'INVALID_CYCLE_DAY',
        'The cycle day is not available',
      );

    let limit;
    try {
      limit = await this.custody.getLimit(dto.custodyAccountId);
    } catch (error) {
      if (error instanceof CustodyRejectedError)
        throw new NotFoundError(
          'CUSTODY_ACCOUNT_NOT_FOUND',
          'Custody account not found',
        );
      if (error instanceof CustodyUnavailableError)
        throw new ServiceUnavailableError(
          'CUSTODY_UNAVAILABLE',
          'Custody is not available right now',
        );
      throw error;
    }
    if (limit.ownerId !== user.userId)
      throw new NotFoundError(
        'CUSTODY_ACCOUNT_NOT_FOUND',
        'Custody account not found',
      );
    if (limit.cupo <= 0)
      throw new UnprocessableError(
        'NO_COLLATERAL',
        'The custody account has no confirmed collateral',
      );

    const result = await this.run(
      'request-card',
      user.userId,
      key,
      dto,
      async (tx) => {
        const existing = await tx.cardAccount.findUnique({
          where: { custodyAccountId: dto.custodyAccountId },
        });
        if (existing)
          throw new ConflictError(
            'CARD_ALREADY_EXISTS',
            'A card already exists for this custody account',
          );
        const account = await tx.cardAccount.create({
          data: {
            ownerId: user.userId,
            custodyAccountId: dto.custodyAccountId,
            currency: limit.currency,
            cycleDay: dto.cycleDay,
            termsVersion: terms.version,
            createdAt: this.clock.now(),
          },
        });
        await this.audit.record(tx, {
          action: 'card.requested',
          entityType: 'card_account',
          entityId: account.id,
          data: { cycleDay: dto.cycleDay },
        });
        const row = await this.ledger.lock(tx, account.id);
        return { statusCode: 201, body: this.view(row, toMinor(limit.cupo)) };
      },
    );
    await this.limits.store(limit);
    return result;
  }

  async getAccount(user: CurrentUserInfo, id: string): Promise<AccountView> {
    const row = await this.findOwned(user, id);
    let cupo: bigint | null = null;
    try {
      cupo = await this.limits.getCupo(row.custody_account_id);
    } catch (error) {
      if (!(error instanceof LimitUnavailableError)) throw error;
    }
    return this.view(row, cupo);
  }

  async listMovements(
    user: CurrentUserInfo,
    id: string,
    limit: number,
    offset: number,
  ) {
    await this.findOwned(user, id);
    const items = await this.prisma.movement.findMany({
      where: { accountId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      skip: offset,
    });
    return items.map((m) => ({
      id: m.id,
      type: m.type,
      bucket: m.bucket,
      direction: m.direction,
      amount: fromMinor(m.amount),
      bucketBalanceAfter: fromMinor(m.bucketBalanceAfter),
      referenceMovementId: m.referenceMovementId,
      note: m.note,
      createdAt: m.createdAt,
    }));
  }

  async authorize(
    caller: CurrentUserInfo,
    accountId: string,
    key: string,
    dto: AuthorizeDto,
  ): Promise<IdempotentResult<AuthorizationResult>> {
    const account = await this.prisma.cardAccount.findUnique({
      where: { id: accountId },
      select: { custodyAccountId: true, termsVersion: true },
    });
    if (!account)
      throw new NotFoundError('ACCOUNT_NOT_FOUND', 'Account not found');
    const deferral = dto.installments
      ? await this.resolveInstallments(account.termsVersion, dto)
      : undefined;
    const cupo = await this.limits.getCupo(account.custodyAccountId);

    return this.run(
      `authorize:${accountId}`,
      caller.userId,
      key,
      dto,
      async (tx) => {
        const row = await this.ledger.releaseExpiredCap(
          tx,
          await this.ledger.lock(tx, accountId),
        );
        const amount = BigInt(dto.amount);
        const available = availableCredit(cupo, row.limit_cap, debtOf(row));

        if (row.status !== 'ACTIVE')
          return this.decline(row, 'ACCOUNT_NOT_ACTIVE', available);
        if (amount > available)
          return this.decline(row, 'INSUFFICIENT_CREDIT', available);

        const posted = await this.ledger.post(tx, row, {
          type: 'PURCHASE',
          bucket: deferral ? 'DEFERRED' : 'PRINCIPAL',
          direction: 'DEBIT',
          amount,
          note: dto.merchant,
          installments: deferral?.installments,
          rateBps: deferral?.rateBps,
        });
        await this.audit.record(tx, {
          action: 'authorization.approved',
          entityType: 'movement',
          entityId: posted.movementId,
          data: { accountId, amount: dto.amount },
        });
        return {
          statusCode: 201,
          body: {
            authorizationId: posted.movementId,
            status: 'APPROVED',
            availableCredit: fromMinor(available - amount),
            ...(deferral
              ? {
                  installments: deferral.installments,
                  installmentAprBps: deferral.rateBps,
                }
              : {}),
          },
        };
      },
    );
  }

  async reverseAuthorization(
    caller: CurrentUserInfo,
    accountId: string,
    authorizationId: string,
    key: string,
  ): Promise<IdempotentResult<{ reversalId: string; amount: number }>> {
    return this.run(
      `reverse:${accountId}:${authorizationId}`,
      caller.userId,
      key,
      {},
      async (tx) => {
        const row = await this.ledger.lock(tx, accountId);
        if (row.status === 'CLOSING' || row.status === 'CLOSED')
          throw new ConflictError(
            'ACCOUNT_NOT_REVERSIBLE',
            'The account is closing or closed',
          );

        const original = await tx.movement.findFirst({
          where: { id: authorizationId, accountId, type: 'PURCHASE' },
        });
        if (!original)
          throw new NotFoundError(
            'AUTHORIZATION_NOT_FOUND',
            'Authorization not found',
          );
        const existing = await tx.movement.findFirst({
          where: { referenceMovementId: authorizationId, type: 'REVERSAL' },
        });
        if (existing)
          throw new ConflictError(
            'ALREADY_REVERSED',
            'The authorization was already reversed',
          );
        if (original.bucket === 'DEFERRED') {
          const plan = await tx.installmentPlan.findUnique({
            where: { purchaseMovementId: original.id },
          });
          if (plan)
            throw new UnprocessableError(
              'DEFERRED_PURCHASE_ALREADY_BILLED',
              'The deferred purchase already started billing and cannot be reversed',
            );
        } else if (row.principal < original.amount) {
          throw new UnprocessableError(
            'REVERSAL_EXCEEDS_BALANCE',
            'The authorization was already paid and cannot be reversed',
          );
        }

        const posted = await this.ledger.post(tx, row, {
          type: 'REVERSAL',
          bucket: original.bucket,
          direction: 'CREDIT',
          amount: original.amount,
          referenceMovementId: original.id,
        });
        await this.audit.record(tx, {
          action: 'authorization.reversed',
          entityType: 'movement',
          entityId: posted.movementId,
          data: { accountId, authorizationId },
        });
        return {
          statusCode: 201,
          body: {
            reversalId: posted.movementId,
            amount: fromMinor(original.amount),
          },
        };
      },
    );
  }

  async pay(
    user: CurrentUserInfo,
    accountId: string,
    key: string,
    dto: PaymentDto,
  ) {
    return this.run(`pay:${accountId}`, user.userId, key, dto, async (tx) => {
      const row = await this.ledger.lock(tx, accountId);
      this.policy.assertCanAccessOwned(user, row.owner_id);
      if (row.status !== 'ACTIVE' && row.status !== 'DELINQUENT')
        throw new ConflictError(
          'ACCOUNT_NOT_PAYABLE',
          'The account does not accept payments',
        );

      let remaining = BigInt(dto.amount);
      if (remaining > payableOf(row))
        throw new UnprocessableError(
          'PAYMENT_EXCEEDS_DEBT',
          'The payment is larger than the amount owed',
        );

      let current = row;
      const applied: { bucket: BucketName; amount: number }[] = [];
      for (const [bucket, column] of [
        ['FEES', 'fees'],
        ['INTEREST', 'interest'],
        ['PRINCIPAL', 'principal'],
      ] as const) {
        const part = remaining < current[column] ? remaining : current[column];
        if (part === 0n) continue;
        const posted = await this.ledger.post(tx, current, {
          type: 'PAYMENT',
          bucket,
          direction: 'CREDIT',
          amount: part,
        });
        current = posted.account;
        remaining -= part;
        applied.push({ bucket, amount: fromMinor(part) });
      }
      await this.hooks.run(tx, current);
      await this.audit.record(tx, {
        action: 'payment.applied',
        entityType: 'card_account',
        entityId: accountId,
        data: { amount: dto.amount, applied },
      });
      return {
        statusCode: 201,
        body: { applied, debt: fromMinor(debtOf(current)) },
      };
    });
  }

  async findOwned(user: CurrentUserInfo, id: string): Promise<AccountRow> {
    const rows = await this.prisma.$queryRaw<AccountRow[]>`
      SELECT id, owner_id, custody_account_id, currency, status, principal, deferred, interest, fees,
             limit_cap, limit_cap_settled_at, cycle_day, terms_version
      FROM card_accounts WHERE id = ${id}::uuid`;
    const row = rows[0];
    if (!row) throw new NotFoundError('ACCOUNT_NOT_FOUND', 'Account not found');
    this.policy.assertCanAccessOwned(user, row.owner_id);
    return row;
  }

  private async resolveInstallments(termsVersion: number, dto: AuthorizeDto) {
    const terms = await this.terms.getVersion(termsVersion);
    const option = terms.installmentOptions.find(
      (o) => o.months === dto.installments,
    );
    if (!option)
      throw new UnprocessableError(
        'INSTALLMENTS_NOT_AVAILABLE',
        'The requested number of installments is not offered',
      );
    if (BigInt(dto.amount) < terms.minInstallmentPurchase)
      throw new UnprocessableError(
        'AMOUNT_BELOW_INSTALLMENT_MINIMUM',
        'The purchase is below the minimum amount for installments',
      );
    return { installments: option.months, rateBps: option.aprBps };
  }

  private decline(
    row: AccountRow,
    reason: string,
    available: bigint,
  ): IdempotentResult<AuthorizationResult> {
    return {
      statusCode: 200,
      body: {
        authorizationId: null,
        status: 'DECLINED',
        reason,
        availableCredit: fromMinor(available),
      },
    };
  }

  private view(row: AccountRow, cupo: bigint | null): AccountView {
    const debt = debtOf(row);
    return {
      id: row.id,
      ownerId: row.owner_id,
      custodyAccountId: row.custody_account_id,
      currency: row.currency,
      status: row.status,
      cycleDay: row.cycle_day,
      balances: {
        principal: fromMinor(row.principal),
        deferred: fromMinor(row.deferred),
        interest: fromMinor(row.interest),
        fees: fromMinor(row.fees),
        debt: fromMinor(debt),
      },
      limit: {
        cupo: cupo === null ? null : fromMinor(cupo),
        cap: row.limit_cap === null ? null : fromMinor(row.limit_cap),
      },
      availableCredit:
        cupo === null
          ? null
          : fromMinor(availableCredit(cupo, row.limit_cap, debt)),
    };
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
}
