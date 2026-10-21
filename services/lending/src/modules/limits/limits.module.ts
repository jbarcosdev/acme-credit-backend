import { Module } from '@nestjs/common';
import { LimitChangedConsumer } from './limit-changed.consumer.js';
import { LIMITS_CONFIG, limitsConfigFromEnv } from './limits.config.js';
import { LimitsService } from './limits.service.js';

@Module({
  providers: [
    { provide: LIMITS_CONFIG, useFactory: () => limitsConfigFromEnv() },
    LimitsService,
    LimitChangedConsumer,
  ],
  exports: [LimitsService],
})
export class LimitsModule {}
