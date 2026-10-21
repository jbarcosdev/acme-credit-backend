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
  RequireScopes,
  type CurrentUserInfo,
} from '@acme/auth';
import { SCOPES } from '@acme/contracts';
import { IdempotencyKeyHeader } from '@acme/nest-common';
import { CustodyService } from './custody.service.js';
import { LimitReductionDto, SettlementDto } from './dto/custody.dto.js';

@Controller('custody-accounts')
@RequirePrincipal('service')
export class InternalCustodyController {
  constructor(private readonly custody: CustodyService) {}

  @Get(':id/limit')
  @RequireScopes(SCOPES.custodyRead)
  limit(@Param('id', ParseUUIDPipe) id: string) {
    return this.custody.getLimit(id);
  }

  @Post(':id/settlements')
  @RequireScopes(SCOPES.custodySettle)
  async settle(
    @CurrentUser() caller: CurrentUserInfo,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKeyHeader() key: string,
    @Body() dto: SettlementDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.custody.settle(caller, id, key, dto);
    res.status(result.statusCode);
    return result.body;
  }

  @Post(':id/limit-reductions')
  @RequireScopes(SCOPES.custodySettle)
  async reduce(
    @CurrentUser() caller: CurrentUserInfo,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKeyHeader() key: string,
    @Body() dto: LimitReductionDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.custody.reduceLimit(caller, id, key, dto);
    res.status(result.statusCode);
    return result.body;
  }
}
