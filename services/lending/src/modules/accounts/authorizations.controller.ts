import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  CurrentUser,
  RequirePrincipal,
  RequireScopes,
  type CurrentUserInfo,
} from '@acme/auth';
import { SCOPES } from '@acme/contracts';
import { IdempotencyKeyHeader } from '@acme/nest-common';
import { AccountsService } from './accounts.service.js';
import { AuthorizeDto } from './dto/accounts.dto.js';

@Controller('accounts/:accountId/authorizations')
@RequirePrincipal('service')
@RequireScopes(SCOPES.authorizationsWrite)
export class AuthorizationsController {
  constructor(private readonly accounts: AccountsService) {}

  @Post()
  async authorize(
    @CurrentUser() caller: CurrentUserInfo,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @IdempotencyKeyHeader() key: string,
    @Body() dto: AuthorizeDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.accounts.authorize(caller, accountId, key, dto);
    res.status(result.statusCode);
    return result.body;
  }

  @Post(':authorizationId/reversals')
  async reverse(
    @CurrentUser() caller: CurrentUserInfo,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('authorizationId', ParseUUIDPipe) authorizationId: string,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.accounts.reverseAuthorization(
      caller,
      accountId,
      authorizationId,
      key,
    );
    res.status(result.statusCode);
    return result.body;
  }
}
