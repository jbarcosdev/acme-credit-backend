import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  CurrentUser,
  RequirePrincipal,
  RequireScopes,
  type CurrentUserInfo,
} from '@acme/auth';
import { SCOPES } from '@acme/contracts';
import { BillingJobsService } from './billing-jobs.service.js';
import { StatementsService } from './statements.service.js';

@Controller()
export class BillingController {
  constructor(
    private readonly statements: StatementsService,
    private readonly jobs: BillingJobsService,
  ) {}

  @Get('accounts/:id/statements')
  @RequirePrincipal('user')
  list(
    @CurrentUser() user: CurrentUserInfo,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.statements.list(user, id);
  }

  @Get('accounts/:id/statements/:cycleNumber')
  @RequirePrincipal('user')
  get(
    @CurrentUser() user: CurrentUserInfo,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('cycleNumber', ParseIntPipe) cycleNumber: number,
  ) {
    return this.statements.get(user, id, cycleNumber);
  }

  @Post('internal/jobs/daily')
  @RequirePrincipal('service')
  @RequireScopes(SCOPES.jobsRun)
  runDaily() {
    return this.jobs.runDaily();
  }
}
