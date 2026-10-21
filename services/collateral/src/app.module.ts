import { Module } from '@nestjs/common';
import { HealthModule } from '@acme/nest-common';
import { CustodyModule } from './modules/custody/custody.module.js';

@Module({
  imports: [HealthModule, CustodyModule],
})
export class AppModule {}
