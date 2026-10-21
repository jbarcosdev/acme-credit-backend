import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

@Injectable()
export class AccessLogMiddleware implements NestMiddleware {
  private readonly logger = new Logger('access');

  constructor(private readonly cls: ClsService) {}

  use(
    req: { method: string; originalUrl?: string; url: string },
    res: {
      statusCode: number;
      on: (event: string, listener: () => void) => void;
    },
    next: () => void,
  ): void {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const actor = this.cls.isActive()
        ? this.cls.get<{ id: string; type: string } | undefined>('actor')
        : undefined;
      this.logger.log({
        message: 'request',
        correlationId: this.cls.isActive() ? this.cls.getId() : undefined,
        method: req.method,
        path: (req.originalUrl ?? req.url).split('?')[0],
        status: res.statusCode,
        durationMs: Number((process.hrtime.bigint() - start) / 1_000_000n),
        actorId: actor?.id,
        actorType: actor?.type,
      });
    });
    next();
  }
}
