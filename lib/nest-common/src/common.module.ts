import { DynamicModule, Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { Clock, SystemClock } from './clock.js';
import { DomainExceptionFilter } from './domain-exception.filter.js';
import { HealthModule } from './health/health.module.js';

@Module({})
export class CommonModule {
  static register(): DynamicModule {
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
        { provide: APP_FILTER, useClass: DomainExceptionFilter },
        {
          provide: APP_PIPE,
          useValue: new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
          }),
        },
        { provide: Clock, useClass: SystemClock },
      ],
      exports: [Clock],
    };
  }
}
