import { Module } from '@nestjs/common';
import { HealthModule } from '@acme/nest-common';
import { AccountsModule } from './modules/accounts/accounts.module.js';
import { BillingModule } from './modules/billing/billing.module.js';
import { LimitsModule } from './modules/limits/limits.module.js';

@Module({
  imports: [HealthModule, AccountsModule, BillingModule, LimitsModule],
})
export class AppModule {}
