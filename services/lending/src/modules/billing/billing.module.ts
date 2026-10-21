import { Module } from '@nestjs/common';
import { AuditService } from '@acme/nest-common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { BillingController } from './billing.controller.js';
import { BillingJobsService } from './billing-jobs.service.js';
import { CycleService } from './cycle.service.js';
import { DelinquencyService } from './delinquency.service.js';
import { StatementsService } from './statements.service.js';

@Module({
  imports: [AccountsModule],
  controllers: [BillingController],
  providers: [
    CycleService,
    DelinquencyService,
    StatementsService,
    BillingJobsService,
    AuditService,
  ],
  exports: [BillingJobsService],
})
export class BillingModule {}
