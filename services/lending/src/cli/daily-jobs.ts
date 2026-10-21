import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { BillingJobsService } from '../modules/billing/billing-jobs.service.js';

const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
try {
  const result = await app.get(BillingJobsService).runDaily();
  console.log(JSON.stringify(result));
} finally {
  await app.close();
}
