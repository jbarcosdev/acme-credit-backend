import { Module } from '@nestjs/common';
import { AuthModule } from '@acme/auth';
import { CommonModule } from '@acme/nest-common';
import { ClientsModule } from './clients/clients.module.js';
import { AccountsModule } from './modules/accounts/accounts.module.js';
import { BillingModule } from './modules/billing/billing.module.js';
import { LimitsModule } from './modules/limits/limits.module.js';
import { PrismaModule } from './shared/prisma.module.js';

@Module({
  imports: [
    CommonModule.register(),
    AuthModule.register(),
    PrismaModule,
    ClientsModule,
    LimitsModule,
    AccountsModule,
    BillingModule,
  ],
})
export class AppModule {}
