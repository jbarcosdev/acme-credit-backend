import { Injectable } from '@nestjs/common';
import { AuditService, Clock } from '@acme/nest-common';
import { LendingTermsProvider } from '../../clients/terms/lending-terms.provider.js';
import { PrismaService } from '../../shared/prisma.service.js';
import type { AccountRow } from '../accounts/account-types.js';
import { ClosureService } from '../accounts/closure.service.js';
import { LedgerService } from '../accounts/ledger.service.js';
import type { PaymentHook } from '../accounts/payment-hooks.js';
import { PaymentHooks } from '../accounts/payment-hooks.js';
import type { Tx } from './billing.types.js';
import { addDays, dateOnly } from './dates.js';

@Injectable()
export class DelinquencyService implements PaymentHook {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly terms: LendingTermsProvider,
    private readonly audit: AuditService,
    private readonly closure: ClosureService,
    private readonly clock: Clock,
    hooks: PaymentHooks,
  ) {
    hooks.register(this);
  }

  async afterPayment(tx: Tx, account: AccountRow): Promise<void> {
    if (account.status !== 'DELINQUENT') return;
    const late = await tx.statementOutcome.findFirst({
      where: { outcome: 'LATE', statement: { accountId: account.id } },
      orderBy: { statement: { cycleNumber: 'desc' } },
      include: { statement: true },
    });
    if (!late) return;
    const paid = await this.paymentsSince(
      tx,
      account.id,
      late.statement.periodEnd,
      null,
    );
    if (paid < late.statement.minimumPayment) return;
    await tx.cardAccount.update({
      where: { id: account.id },
      data: { status: 'ACTIVE' },
    });
    await tx.billingProfile.updateMany({
      where: { accountId: account.id },
      data: { delinquentSince: null },
    });
    await this.audit.record(tx, {
      action: 'account.cured',
      entityType: 'card_account',
      entityId: account.id,
    });
  }

  async evaluateDueStatements(): Promise<number> {
    const today = dateOnly(this.clock.now());
    const pending = await this.prisma.statement.findMany({
      where: {
        dueDate: { lt: today },
        outcome: null,
        account: { status: { in: ['ACTIVE', 'DELINQUENT'] } },
      },
      select: { id: true, accountId: true },
      orderBy: { dueDate: 'asc' },
    });
    let late = 0;
    for (const { id, accountId } of pending) {
      if (await this.evaluate(id, accountId)) late++;
    }
    return late;
  }

  private async evaluate(
    statementId: string,
    accountId: string,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.ledger.lock(tx, accountId);
      if (row.status !== 'ACTIVE' && row.status !== 'DELINQUENT') return false;
      const existing = await tx.statementOutcome.findUnique({
        where: { statementId },
      });
      if (existing) return false;

      const statement = await tx.statement.findUniqueOrThrow({
        where: { id: statementId },
      });
      const terms = await this.terms.getVersion(row.terms_version);
      const paid = await this.paymentsSince(
        tx,
        accountId,
        statement.periodEnd,
        addDays(statement.dueDate, 1),
      );
      const isLate =
        statement.minimumPayment > 0n && paid < statement.minimumPayment;

      await tx.statementOutcome.create({
        data: { statementId, outcome: isLate ? 'LATE' : 'PAID' },
      });
      if (!isLate) return false;

      await this.ledger.post(tx, row, {
        type: 'LATE_FEE',
        bucket: 'FEES',
        direction: 'DEBIT',
        amount: terms.lateFeeAmount,
        statementId,
      });
      if (row.status === 'ACTIVE')
        await tx.cardAccount.update({
          where: { id: accountId },
          data: { status: 'DELINQUENT' },
        });
      await tx.billingProfile.updateMany({
        where: { accountId, delinquentSince: null },
        data: { delinquentSince: statement.dueDate },
      });
      await this.audit.record(tx, {
        action: 'statement.late',
        entityType: 'statement',
        entityId: statementId,
        data: {
          accountId,
          minimumPayment: statement.minimumPayment.toString(),
          paid: paid.toString(),
          fee: terms.lateFeeAmount.toString(),
        },
      });
      return true;
    });
  }

  async chargeOff(): Promise<number> {
    const today = dateOnly(this.clock.now());
    const candidates = await this.prisma.billingProfile.findMany({
      where: {
        delinquentSince: { not: null },
        account: { status: 'DELINQUENT' },
      },
      include: { account: { select: { termsVersion: true } } },
    });
    let closed = 0;
    for (const profile of candidates) {
      const terms = await this.terms.getVersion(profile.account.termsVersion);
      const since = profile.delinquentSince as Date;
      if (addDays(since, terms.chargeOffDays).getTime() > today.getTime())
        continue;
      const started = await this.prisma.$transaction(async (tx) => {
        const row = await this.ledger.lock(tx, profile.accountId);
        if (row.status !== 'DELINQUENT') return false;
        await this.closure.markClosing(tx, row, 'CHARGE_OFF');
        return true;
      });
      if (
        started &&
        (await this.closure.process(profile.accountId)) === 'CLOSED'
      )
        closed++;
    }
    return closed;
  }

  private async paymentsSince(
    tx: Tx,
    accountId: string,
    from: Date,
    to: Date | null,
  ): Promise<bigint> {
    const result = await tx.movement.aggregate({
      _sum: { amount: true },
      where: {
        accountId,
        type: 'PAYMENT',
        effectiveAt: { gte: from, ...(to ? { lt: to } : {}) },
      },
    });
    return result._sum.amount ?? 0n;
  }
}
