import { Module } from '@nestjs/common';
import { AuthorizationsModule } from './modules/authorizations/authorizations.module.js';
import { CardsModule } from './modules/cards/cards.module.js';
import { CollateralModule } from './modules/collateral/collateral.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { LedgerModule } from './modules/ledger/ledger.module.js';
import { RepaymentsModule } from './modules/repayments/repayments.module.js';

@Module({
  imports: [
    HealthModule,
    CollateralModule,
    CardsModule,
    AuthorizationsModule,
    RepaymentsModule,
    LedgerModule,
  ],
})
export class AppModule {}
