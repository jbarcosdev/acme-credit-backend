import {
  Controller,
  HttpCode,
  Param,
  Post,
  Req,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { Public } from '@acme/auth';
import { Clock } from '@acme/nest-common';
import { InvalidWebhookError } from '../../clients/banks/bank-adapter.js';
import { BankRegistry } from '../../clients/banks/bank-registry.js';
import { CustodyService } from './custody.service.js';

@Controller('webhooks/banks')
export class BankWebhookController {
  constructor(
    private readonly custody: CustodyService,
    private readonly banks: BankRegistry,
    private readonly clock: Clock,
    private readonly cls: ClsService,
  ) {}

  @Public()
  @Post(':bankId')
  @HttpCode(200)
  async receive(
    @Param('bankId') bankId: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const adapter = this.banks.get(bankId);
    let event;
    try {
      event = adapter.parseWebhook(
        req.rawBody ?? Buffer.alloc(0),
        req.headers,
        this.clock.now(),
      );
    } catch (error) {
      if (error instanceof InvalidWebhookError)
        throw new UnauthorizedException();
      throw error;
    }
    this.cls.set('actor', { id: `bank:${bankId}`, type: 'bank' });
    const result = await this.custody.confirmDeposit(event);
    return result.body;
  }
}
