import {
  DynamicModule,
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { AccessLogMiddleware } from './access-log.middleware.js';
import { Clock, OffsetClock, SystemClock } from './clock.js';
import { DomainExceptionFilter } from './domain-exception.filter.js';
import { HealthModule } from './health/health.module.js';

@Module({})
export class CommonModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(AccessLogMiddleware)
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }

  static register(options: { devClock?: boolean } = {}): DynamicModule {
    if (options.devClock && process.env.NODE_ENV === 'production') {
      throw new Error('The development clock cannot be enabled in production');
    }
    return {
      module: CommonModule,
      global: true,
      imports: [
        ClsModule.forRoot({
          global: true,
          middleware: { mount: true, generateId: true },
        }),
        HealthModule,
      ],
      providers: [
        AccessLogMiddleware,
        { provide: APP_FILTER, useClass: DomainExceptionFilter },
        {
          provide: APP_PIPE,
          useValue: new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
          }),
        },
        {
          provide: Clock,
          useClass: options.devClock ? OffsetClock : SystemClock,
        },
      ],
      exports: [Clock],
    };
  }
}
