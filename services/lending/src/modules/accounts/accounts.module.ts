import { Module } from '@nestjs/common';
import { AuditService, IdempotencyService } from '@acme/nest-common';
import { LimitsModule } from '../limits/limits.module.js';
import { AccountsController } from './accounts.controller.js';
import { AccountsService } from './accounts.service.js';
import { AuthorizationsController } from './authorizations.controller.js';
import { LedgerService } from './ledger.service.js';

@Module({
  imports: [LimitsModule],
  controllers: [AccountsController, AuthorizationsController],
  providers: [AccountsService, LedgerService, IdempotencyService, AuditService],
  exports: [AccountsService, LedgerService],
})
export class AccountsModule {}
