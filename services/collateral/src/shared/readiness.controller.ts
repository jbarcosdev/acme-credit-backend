import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '@acme/auth';
import { PrismaService } from './prisma.service.js';

@Controller('health')
export class ReadinessController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException();
    }
  }
}
