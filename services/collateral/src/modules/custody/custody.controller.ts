import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  CurrentUser,
  RequirePrincipal,
  type CurrentUserInfo,
} from '@acme/auth';
import { IdempotencyKeyHeader } from '@acme/nest-common';
import { CustodyService } from './custody.service.js';
import { CreateDepositDto, OpenAccountDto } from './dto/custody.dto.js';

@Controller('custody-accounts')
@RequirePrincipal('user')
export class CustodyController {
  constructor(private readonly custody: CustodyService) {}

  @Post()
  async open(
    @CurrentUser() user: CurrentUserInfo,
    @IdempotencyKeyHeader() key: string,
    @Body() dto: OpenAccountDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.custody.openAccount(user, key, dto);
    res.status(result.statusCode);
    return result.body;
  }

  @Get(':id')
  get(
    @CurrentUser() user: CurrentUserInfo,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.custody.getAccount(user, id);
  }

  @Post(':id/deposits')
  async deposit(
    @CurrentUser() user: CurrentUserInfo,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKeyHeader() key: string,
    @Body() dto: CreateDepositDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.custody.createDeposit(user, id, key, dto);
    res.status(result.statusCode);
    return result.body;
  }
}
