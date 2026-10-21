import { Injectable } from '@nestjs/common';
import { AccessPolicy, type CurrentUserInfo } from '@acme/auth';
import {
  AuditService,
  Clock,
  ConflictError,
  fromMinor,
  IdempotencyService,
  UnprocessableError,
} from '@acme/nest-common';
import {
  CustodyClient,
  CustodyRejectedError,
  CustodyUnavailableError,
} from '../../clients/custody/custody.client.js';
import { PrismaService } from '../../shared/prisma.service.js';
import { LimitsService } from '../limits/limits.service.js';
import { debtOf } from './account-types.js';
import { LedgerService } from './ledger.service.js';

export interface ReductionView {
  status: 'APPLIED' | 'PENDING';
  newCupo: number;
}

@Injectable()
export class LimitReductionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly policy: AccessPolicy,
    private readonly ledger: LedgerService,
    private readonly custody: CustodyClient,
    private readonly limits: LimitsService,
    private readonly clock: Clock,
  ) {}

  async request(
    user: CurrentUserInfo,
    accountId: string,
    key: string,
    newCupo: number,
  ): Promise<{ statusCode: number; body: ReductionView }> {
    await this.prisma.$transaction((tx) =>
      this.idempotency.execute(
        tx,
        {
          scope: `reduce:${accountId}`,
          ownerId: user.userId,
          key,
          request: { newCupo },
        },
        async () => {
          const row = await this.ledger.releaseExpiredCap(
            tx,
            await this.ledger.lock(tx, accountId),
          );
          this.policy.assertCanAccessOwned(user, row.owner_id);
          if (row.status !== 'ACTIVE')
            throw new ConflictError(
              'ACCOUNT_NOT_ACTIVE',
              'Only active accounts can reduce their limit',
            );
          if (row.limit_cap !== null)
            throw new ConflictError(
              'REDUCTION_IN_PROGRESS',
              'A limit reduction is already in progress',
            );
          if (debtOf(row) > BigInt(newCupo))
            throw new UnprocessableError(
              'DEBT_EXCEEDS_NEW_LIMIT',
              'The outstanding debt is larger than the requested limit',
            );
          await tx.cardAccount.update({
            where: { id: accountId },
            data: { limitCap: BigInt(newCupo) },
          });
          await this.audit.record(tx, {
            action: 'limit.reduction.requested',
            entityType: 'card_account',
            entityId: accountId,
            data: { newCupo },
          });
          return { statusCode: 202, body: {} };
        },
      ),
    );
    const applied = await this.complete(accountId);
    return {
      statusCode: applied ? 200 : 202,
      body: { status: applied ? 'APPLIED' : 'PENDING', newCupo },
    };
  }

  async complete(accountId: string): Promise<boolean> {
    const account = await this.prisma.cardAccount.findUnique({
      where: { id: accountId },
    });
    if (
      !account ||
      account.limitCap === null ||
      account.limitCapSettledAt !== null
    )
      return false;
    const cap = account.limitCap;

    let reduced;
    try {
      reduced = await this.custody.reduceLimit(
        account.custodyAccountId,
        `reduce:${accountId}:${cap}`,
        fromMinor(cap),
      );
    } catch (error) {
      if (
        error instanceof CustodyUnavailableError ||
        error instanceof CustodyRejectedError
      )
        return false;
      throw error;
    }

    await this.limits.store({
      custodyAccountId: account.custodyAccountId,
      ownerId: account.ownerId,
      currency: account.currency,
      cupo: reduced.cupo,
      version: reduced.version,
    });
    await this.prisma.$transaction(async (tx) => {
      const row = await this.ledger.lock(tx, accountId);
      if (row.limit_cap !== cap) return;
      await tx.cardAccount.update({
        where: { id: accountId },
        data: { limitCapSettledAt: this.clock.now() },
      });
      await this.audit.record(tx, {
        action: 'limit.reduction.applied',
        entityType: 'card_account',
        entityId: accountId,
        data: { cupo: reduced.cupo, released: reduced.released },
      });
    });
    return true;
  }

  async releaseSettledCaps(): Promise<number> {
    const settled = await this.prisma.cardAccount.findMany({
      where: { limitCap: { not: null }, limitCapSettledAt: { not: null } },
      select: { id: true },
    });
    let released = 0;
    for (const { id } of settled) {
      const done = await this.prisma.$transaction(async (tx) => {
        const row = await this.ledger.lock(tx, id);
        const after = await this.ledger.releaseExpiredCap(tx, row);
        if (after.limit_cap === null && row.limit_cap !== null) {
          await this.audit.record(tx, {
            action: 'limit.cap.released',
            entityType: 'card_account',
            entityId: id,
          });
          return true;
        }
        return false;
      });
      if (done) released++;
    }
    return released;
  }

  async retryPending(): Promise<number> {
    const pending = await this.prisma.cardAccount.findMany({
      where: { limitCap: { not: null }, limitCapSettledAt: null },
      select: { id: true },
    });
    let applied = 0;
    for (const { id } of pending) {
      if (await this.complete(id)) applied++;
    }
    return applied;
  }
}
