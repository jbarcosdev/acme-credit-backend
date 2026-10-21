import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { ReadinessController } from './readiness.controller.js';

@Global()
@Module({
  controllers: [ReadinessController],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
