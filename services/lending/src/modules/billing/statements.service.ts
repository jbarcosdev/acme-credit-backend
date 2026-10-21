import { Injectable } from '@nestjs/common';
import type { CurrentUserInfo } from '@acme/auth';
import { fromMinor, NotFoundError } from '@acme/nest-common';
import { PrismaService } from '../../shared/prisma.service.js';
import { AccountsService } from '../accounts/accounts.service.js';
import type { PlanView, StatementView } from './billing.types.js';

const iso = (date: Date) => date.toISOString().slice(0, 10);

@Injectable()
export class StatementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
  ) {}

  async list(
    user: CurrentUserInfo,
    accountId: string,
  ): Promise<StatementView[]> {
    await this.accounts.findOwned(user, accountId);
    const statements = await this.prisma.statement.findMany({
      where: { accountId },
      orderBy: { cycleNumber: 'desc' },
    });
    return statements.map((s) => this.view(s));
  }

  async get(
    user: CurrentUserInfo,
    accountId: string,
    cycleNumber: number,
  ): Promise<StatementView> {
    await this.accounts.findOwned(user, accountId);
    const statement = await this.prisma.statement.findUnique({
      where: { accountId_cycleNumber: { accountId, cycleNumber } },
    });
    if (!statement)
      throw new NotFoundError('STATEMENT_NOT_FOUND', 'Statement not found');
    return this.view(statement);
  }

  async plans(user: CurrentUserInfo, accountId: string): Promise<PlanView[]> {
    await this.accounts.findOwned(user, accountId);
    const plans = await this.prisma.installmentPlan.findMany({
      where: { accountId },
      orderBy: { createdAt: 'asc' },
    });
    return plans.map((p) => ({
      id: p.id,
      purchaseMovementId: p.purchaseMovementId,
      principal: fromMinor(p.principal),
      installments: p.installments,
      aprBps: p.aprBps,
      installmentAmount: fromMinor(p.installmentAmount),
      billed: p.billedCount,
      remainingPrincipal: fromMinor(p.remainingPrincipal),
      status: p.status,
    }));
  }

  private view(
    s: Awaited<ReturnType<PrismaService['statement']['findUniqueOrThrow']>>,
  ): StatementView {
    return {
      id: s.id,
      cycleNumber: s.cycleNumber,
      periodStart: iso(s.periodStart),
      periodEnd: iso(s.periodEnd),
      dueDate: iso(s.dueDate),
      openingBalance: fromMinor(s.openingBalance),
      purchases: fromMinor(s.purchases),
      reversals: fromMinor(s.reversals),
      payments: fromMinor(s.payments),
      interestCharged: fromMinor(s.interestCharged),
      feesCharged: fromMinor(s.feesCharged),
      closingBalance: fromMinor(s.closingBalance),
      minimumPayment: fromMinor(s.minimumPayment),
      termsVersion: s.termsVersion,
      installmentPrincipal: fromMinor(s.installmentPrincipal),
      installmentInterest: fromMinor(s.installmentInterest),
      deferredPurchases: fromMinor(s.deferredPurchases),
      deferredBalance: fromMinor(s.deferredBalance),
      installments: s.installmentDetails,
    };
  }
}
