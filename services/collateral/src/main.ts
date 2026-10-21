import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const production = process.env.NODE_ENV === 'production';
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    logger: new ConsoleLogger({ json: production, colors: !production }),
  });
  app.use(helmet());
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3001);
}
await bootstrap();
