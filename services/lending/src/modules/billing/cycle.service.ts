import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AuditService, Clock } from '@acme/nest-common';
import { LendingTermsProvider } from '../../clients/terms/lending-terms.provider.js';
import { PrismaService } from '../../shared/prisma.service.js';
import { LedgerService } from '../accounts/ledger.service.js';
import { addDays, dateOnly, daysBetween, nextCutDate } from './dates.js';
import { interestFor, minimumPaymentFor } from './rounding.js';
import type { Tx } from './billing.types.js';

const MAX_CUTS_PER_ACCOUNT = 36;

@Injectable()
export class CycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly terms: LendingTermsProvider,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async ensureProfiles(): Promise<number> {
    const missing = await this.prisma.cardAccount.findMany({
      where: { status: { in: ['ACTIVE', 'DELINQUENT'] }, profile: null },
      select: { id: true, createdAt: true, cycleDay: true },
    });
    for (const account of missing) {
      await this.prisma.billingProfile
        .create({
          data: {
            accountId: account.id,
            nextCutDate: nextCutDate(account.createdAt, account.cycleDay),
          },
        })
        .catch(() => undefined);
    }
    return missing.length;
  }

  async runCuts(): Promise<number> {
    await this.ensureProfiles();
    const today = dateOnly(this.clock.now());
    const due = await this.prisma.billingProfile.findMany({
      where: {
        nextCutDate: { lte: today },
        account: { status: { in: ['ACTIVE', 'DELINQUENT'] } },
      },
      select: { accountId: true },
    });
    let cuts = 0;
    for (const { accountId } of due) {
      for (let i = 0; i < MAX_CUTS_PER_ACCOUNT; i++) {
        if (!(await this.cutOnce(accountId, today))) break;
        cuts++;
      }
    }
    return cuts;
  }

  async cutOnce(accountId: string, today: Date): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.ledger.lock(tx, accountId);
      if (row.status !== 'ACTIVE' && row.status !== 'DELINQUENT') return false;
      const profile = await tx.billingProfile.findUnique({
        where: { accountId },
      });
      if (!profile || profile.nextCutDate.getTime() > today.getTime())
        return false;

      const account = await tx.cardAccount.findUniqueOrThrow({
        where: { id: accountId },
        select: { createdAt: true },
      });
      const terms = await this.terms.getVersion(row.terms_version);
      const cut = profile.nextCutDate;
      const periodStart = profile.lastCutDate ?? dateOnly(account.createdAt);
      const periodEndInstant = cut;
      const cycleNumber = profile.cycleNumber + 1;

      const previous = await tx.statement.findUnique({
        where: {
          accountId_cycleNumber: {
            accountId,
            cycleNumber: profile.cycleNumber,
          },
        },
      });
      const opening = previous?.closingBalance ?? 0n;

      const movements = await tx.movement.findMany({
        where: {
          accountId,
          effectiveAt: { gte: periodStart, lt: periodEndInstant },
        },
        orderBy: [{ effectiveAt: 'asc' }, { createdAt: 'asc' }],
      });
      const priorPrincipal = await this.principalBefore(
        tx,
        accountId,
        periodStart,
      );
      const sumOfDailyBalances = this.sumDailyPrincipal(
        movements,
        periodStart,
        periodEndInstant,
        priorPrincipal,
      );

      const total = (type: string, direction: 'DEBIT' | 'CREDIT') =>
        movements
          .filter((m) => m.type === type && m.direction === direction)
          .reduce((sum, m) => sum + m.amount, 0n);
      const purchases = total('PURCHASE', 'DEBIT');
      const reversals = total('REVERSAL', 'CREDIT');
      const payments = total('PAYMENT', 'CREDIT');
      const feesCharged = total('LATE_FEE', 'DEBIT');

      const statementId = randomUUID();
      const interest = interestFor(sumOfDailyBalances, terms.aprBps);
      if (interest > 0n) {
        await this.ledger.post(tx, row, {
          type: 'INTEREST',
          bucket: 'INTEREST',
          direction: 'DEBIT',
          amount: interest,
          statementId,
          effectiveAt: new Date(periodEndInstant.getTime() - 1),
        });
      }

      const closing =
        opening + purchases + interest + feesCharged - reversals - payments;
      const billed = await this.billedDebtBefore(
        tx,
        accountId,
        periodEndInstant,
      );
      if (closing !== billed) {
        throw new Error(
          `statement for ${accountId} does not reconcile with the journal (${closing} vs ${billed})`,
        );
      }

      const dueDate = addDays(cut, terms.dueDays);
      const snapshot = {
        version: terms.version,
        aprBps: terms.aprBps,
        lateFeeAmount: terms.lateFeeAmount.toString(),
        minPaymentBps: terms.minPaymentBps,
        minPaymentFloor: terms.minPaymentFloor.toString(),
        dueDays: terms.dueDays,
      };
      await tx.statement.create({
        data: {
          id: statementId,
          accountId,
          cycleNumber,
          periodStart,
          periodEnd: cut,
          dueDate,
          openingBalance: opening,
          purchases,
          reversals,
          payments,
          interestCharged: interest,
          feesCharged,
          closingBalance: closing,
          minimumPayment: minimumPaymentFor(
            closing,
            terms.minPaymentBps,
            terms.minPaymentFloor,
          ),
          termsVersion: terms.version,
          termsSnapshot: snapshot,
        },
      });
      await tx.billingProfile.update({
        where: { accountId },
        data: {
          cycleNumber,
          lastCutDate: cut,
          nextCutDate: nextCutDate(cut, row.cycle_day),
        },
      });
      await this.audit.record(tx, {
        action: 'statement.issued',
        entityType: 'statement',
        entityId: statementId,
        data: {
          accountId,
          cycleNumber,
          closing: closing.toString(),
          interest: interest.toString(),
        },
      });
      return true;
    });
  }

  private async principalBefore(
    tx: Tx,
    accountId: string,
    instant: Date,
  ): Promise<bigint> {
    const rows = await tx.$queryRaw<{ balance: bigint | null }[]>`
      SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0)::bigint AS balance
      FROM movements WHERE account_id = ${accountId}::uuid AND bucket = 'PRINCIPAL' AND effective_at < ${instant}`;
    return rows[0]?.balance ?? 0n;
  }

  private async billedDebtBefore(
    tx: Tx,
    accountId: string,
    instant: Date,
  ): Promise<bigint> {
    const rows = await tx.$queryRaw<{ balance: bigint | null }[]>`
      SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0)::bigint AS balance
      FROM movements
      WHERE account_id = ${accountId}::uuid AND bucket IN ('PRINCIPAL', 'INTEREST', 'FEES') AND effective_at < ${instant}`;
    return rows[0]?.balance ?? 0n;
  }

  private sumDailyPrincipal(
    movements: {
      bucket: string;
      direction: string;
      amount: bigint;
      effectiveAt: Date;
    }[],
    from: Date,
    to: Date,
    startingBalance: bigint,
  ): bigint {
    const days = daysBetween(from, to);
    let balance = startingBalance;
    let sum = 0n;
    let index = 0;
    const principal = movements.filter((m) => m.bucket === 'PRINCIPAL');
    for (let day = 0; day < days; day++) {
      const endOfDay = addDays(from, day + 1).getTime();
      while (
        index < principal.length &&
        principal[index].effectiveAt.getTime() < endOfDay
      ) {
        const m = principal[index++];
        balance += m.direction === 'DEBIT' ? m.amount : -m.amount;
      }
      sum += balance;
    }
    return sum;
  }
}
