import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  CurrentUser,
  RequirePrincipal,
  type CurrentUserInfo,
} from '@acme/auth';
import { IdempotencyKeyHeader } from '@acme/nest-common';
import { AccountsService } from './accounts.service.js';
import { PaymentDto, RequestCardDto } from './dto/accounts.dto.js';

@Controller()
@RequirePrincipal('user')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Post('cards')
  async requestCard(
    @CurrentUser() user: CurrentUserInfo,
    @IdempotencyKeyHeader() key: string,
    @Body() dto: RequestCardDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.accounts.requestCard(user, key, dto);
    res.status(result.statusCode);
    return result.body;
  }

  @Get('accounts/:id')
  get(
    @CurrentUser() user: CurrentUserInfo,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.accounts.getAccount(user, id);
  }

  @Get('accounts/:id/movements')
  movements(
    @CurrentUser() user: CurrentUserInfo,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    return this.accounts.listMovements(
      user,
      id,
      Math.min(Math.max(limit, 1), 100),
      Math.max(offset, 0),
    );
  }

  @Post('accounts/:id/payments')
  async pay(
    @CurrentUser() user: CurrentUserInfo,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKeyHeader() key: string,
    @Body() dto: PaymentDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.accounts.pay(user, id, key, dto);
    res.status(result.statusCode);
    return result.body;
  }
}
