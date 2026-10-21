import { Injectable, Logger } from '@nestjs/common';
import { AccessPolicy, type CurrentUserInfo } from '@acme/auth';
import {
  AuditService,
  Clock,
  ConflictError,
  fromMinor,
  IdempotencyService,
  type IdempotentResult,
} from '@acme/nest-common';
import {
  CustodyClient,
  CustodyRejectedError,
  CustodyUnavailableError,
} from '../../clients/custody/custody.client.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../shared/prisma.service.js';
import { debtOf, type AccountRow, type BucketName } from './account-types.js';
import { LedgerService } from './ledger.service.js';

type Tx = Prisma.TransactionClient;

export type ClosureReason = 'CUSTOMER' | 'CHARGE_OFF';

export interface ClosureView {
  status: string;
  debt: number;
  shortfall?: number;
}

const APPLICATION_ORDER: [
  BucketName,
  'fees' | 'interest' | 'principal' | 'deferred',
][] = [
  ['FEES', 'fees'],
  ['INTEREST', 'interest'],
  ['PRINCIPAL', 'principal'],
  ['DEFERRED', 'deferred'],
];

@Injectable()
export class ClosureService {
  private readonly logger = new Logger(ClosureService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly policy: AccessPolicy,
    private readonly ledger: LedgerService,
    private readonly custody: CustodyClient,
    private readonly clock: Clock,
  ) {}

  async requestClosure(
    user: CurrentUserInfo,
    accountId: string,
    key: string,
  ): Promise<{ statusCode: number; body: ClosureView }> {
    await this.prisma.$transaction((tx) =>
      this.idempotency.execute(
        tx,
        { scope: `close:${accountId}`, ownerId: user.userId, key, request: {} },
        async () => {
          const row = await this.ledger.lock(tx, accountId);
          this.policy.assertCanAccessOwned(user, row.owner_id);
          if (row.status === 'CLOSED')
            throw new ConflictError(
              'ACCOUNT_CLOSED',
              'The account is already closed',
            );
          if (row.status !== 'CLOSING')
            await this.markClosing(tx, row, 'CUSTOMER');
          return { statusCode: 202, body: {} };
        },
      ),
    );
    await this.process(accountId);
    return this.currentView(accountId);
  }

  async markClosing(
    tx: Tx,
    row: AccountRow,
    reason: ClosureReason,
  ): Promise<void> {
    const debt = debtOf(row);
    await tx.cardAccount.update({
      where: { id: row.id },
      data: {
        status: 'CLOSING',
        closureKey: `close:${row.id}`,
        closureReason: reason,
        closureDebt: debt,
      },
    });
    await this.audit.record(tx, {
      action: 'account.closing',
      entityType: 'card_account',
      entityId: row.id,
      data: { reason, debt: debt.toString() },
    });
  }

  async process(accountId: string): Promise<'CLOSED' | 'PENDING' | 'SKIPPED'> {
    const account = await this.prisma.cardAccount.findUnique({
      where: { id: accountId },
    });
    if (!account || account.status !== 'CLOSING' || !account.closureKey)
      return 'SKIPPED';

    let settlement;
    try {
      settlement = await this.custody.settle(
        account.custodyAccountId,
        account.closureKey,
        fromMinor(account.closureDebt ?? 0n),
      );
    } catch (error) {
      if (error instanceof CustodyUnavailableError) return 'PENDING';
      if (error instanceof CustodyRejectedError) {
        this.logger.error(
          `custody rejected the settlement of ${accountId}: ${error.code}`,
        );
        return 'PENDING';
      }
      throw error;
    }

    return this.prisma.$transaction(async (tx) => {
      let row = await this.ledger.lock(tx, accountId);
      if (row.status !== 'CLOSING') return 'SKIPPED';

      let remaining = BigInt(settlement.applied);
      for (const [bucket, column] of APPLICATION_ORDER) {
        const part = remaining < row[column] ? remaining : row[column];
        if (part === 0n) continue;
        row = (
          await this.ledger.post(tx, row, {
            type: 'COLLATERAL_APPLICATION',
            bucket,
            direction: 'CREDIT',
            amount: part,
          })
        ).account;
        remaining -= part;
      }
      const shortfall = debtOf(row);
      await tx.cardAccount.update({
        where: { id: accountId },
        data: { status: 'CLOSED', closedAt: this.clock.now() },
      });
      await tx.installmentPlan.updateMany({
        where: { accountId, status: 'ACTIVE' },
        data: { status: 'ACCELERATED' },
      });
      await this.audit.record(tx, {
        action: 'account.closed',
        entityType: 'card_account',
        entityId: accountId,
        data: {
          applied: settlement.applied,
          released: settlement.released,
          shortfall: shortfall.toString(),
        },
      });
      return 'CLOSED' as const;
    });
  }

  async retryPending(): Promise<number> {
    const pending = await this.prisma.cardAccount.findMany({
      where: { status: 'CLOSING' },
      select: { id: true },
    });
    let closed = 0;
    for (const { id } of pending) {
      if ((await this.process(id)) === 'CLOSED') closed++;
    }
    return closed;
  }

  private async currentView(
    accountId: string,
  ): Promise<{ statusCode: number; body: ClosureView }> {
    const row = await this.prisma.cardAccount.findUniqueOrThrow({
      where: { id: accountId },
    });
    const debt = debtOf(row);
    const closed = row.status === 'CLOSED';
    return {
      statusCode: closed ? 200 : 202,
      body: {
        status: row.status,
        debt: fromMinor(closed ? 0n : (row.closureDebt ?? debt)),
        ...(closed && debt > 0n ? { shortfall: fromMinor(debt) } : {}),
      },
    };
  }
}

export type { IdempotentResult };
