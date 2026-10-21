import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EVENT_TYPES, type CustodyLimitChangedPayload } from '@acme/contracts';
import { EventConsumer } from '@acme/messaging';
import { LimitsService } from './limits.service.js';

@Injectable()
export class LimitChangedConsumer implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly consumer: EventConsumer,
    private readonly limits: LimitsService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.consumer.subscribe(EVENT_TYPES.custodyLimitChanged, async (event) => {
      const payload = event.payload as CustodyLimitChangedPayload;
      await this.limits.applyVersion(payload.custodyAccountId, payload.version);
    });
    await this.consumer.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.stop();
  }
}
