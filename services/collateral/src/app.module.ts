import { Module } from '@nestjs/common';
import { AuthModule } from '@acme/auth';
import { CommonModule } from '@acme/nest-common';
import { CustodyModule } from './modules/custody/custody.module.js';
import { PrismaModule } from './shared/prisma.module.js';

@Module({
  imports: [
    CommonModule.register(),
    AuthModule.register(),
    PrismaModule,
    CustodyModule,
  ],
})
export class AppModule {}
