import { Global, Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { Redis } from 'ioredis';
import { LocalServiceTokenProvider, ServiceTokenProvider } from '@acme/auth';
import { Cache, InMemoryCache, RedisCache } from '@acme/cache';
import {
  EventConsumer,
  InMemoryEventBus,
  SqsEventConsumer,
} from '@acme/messaging';
import { CustodyClient, HttpCustodyClient } from './custody/custody.client.js';
import {
  defaultLendingTerms,
  LendingTermsProvider,
  StaticLendingTermsProvider,
} from './terms/lending-terms.provider.js';

@Global()
@Module({
  providers: [
    {
      provide: ServiceTokenProvider,
      useFactory: () =>
        new LocalServiceTokenProvider({
          privateKeyPem: (process.env.SERVICE_PRIVATE_KEY ?? '').replace(
            /\\n/g,
            '\n',
          ),
          issuer: process.env.AUTH_ISSUER ?? '',
          audience: process.env.AUTH_AUDIENCE ?? '',
          serviceId: process.env.SERVICE_ID ?? 'lending',
        }),
    },
    {
      provide: CustodyClient,
      useFactory: (tokens: ServiceTokenProvider) =>
        new HttpCustodyClient(tokens, {
          baseUrl: process.env.CUSTODY_URL ?? 'http://localhost:3001',
          timeoutMs: Number(process.env.LIMIT_REQUEST_TIMEOUT_MS ?? 200),
        }),
      inject: [ServiceTokenProvider],
    },
    {
      provide: Cache,
      useFactory: () =>
        process.env.REDIS_URL
          ? new RedisCache(new Redis(process.env.REDIS_URL))
          : new InMemoryCache(),
    },
    {
      provide: LendingTermsProvider,
      useFactory: () => new StaticLendingTermsProvider(defaultLendingTerms()),
    },
    {
      provide: EventConsumer,
      useFactory: () =>
        process.env.EVENT_BUS === 'sqs'
          ? new SqsEventConsumer(
              new SQSClient({ endpoint: process.env.AWS_ENDPOINT_URL }),
              { queueUrl: process.env.LIMIT_EVENTS_QUEUE_URL as string },
            )
          : new InMemoryEventBus(),
    },
  ],
  exports: [
    ServiceTokenProvider,
    CustodyClient,
    Cache,
    LendingTermsProvider,
    EventConsumer,
  ],
})
export class ClientsModule {}
