import { Injectable } from '@nestjs/common';
import { ClosureService } from '../accounts/closure.service.js';
import { LimitReductionService } from '../accounts/limit-reduction.service.js';
import { CycleService } from './cycle.service.js';
import { DelinquencyService } from './delinquency.service.js';

export interface DailyJobsResult {
  closuresCompleted: number;
  reductionsCompleted: number;
  capsReleased: number;
  statementsIssued: number;
  statementsLate: number;
  accountsChargedOff: number;
}

@Injectable()
export class BillingJobsService {
  constructor(
    private readonly closure: ClosureService,
    private readonly reductions: LimitReductionService,
    private readonly cycles: CycleService,
    private readonly delinquency: DelinquencyService,
  ) {}

  async runDaily(): Promise<DailyJobsResult> {
    const closuresCompleted = await this.closure.retryPending();
    const reductionsCompleted = await this.reductions.retryPending();
    const capsReleased = await this.reductions.releaseSettledCaps();
    const statementsIssued = await this.cycles.runCuts();
    const statementsLate = await this.delinquency.evaluateDueStatements();
    const accountsChargedOff = await this.delinquency.chargeOff();
    return {
      closuresCompleted,
      reductionsCompleted,
      capsReleased,
      statementsIssued,
      statementsLate,
      accountsChargedOff,
    };
  }
}
