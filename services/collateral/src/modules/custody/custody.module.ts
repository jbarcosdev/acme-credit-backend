import { Module } from '@nestjs/common';
import { SNSClient } from '@aws-sdk/client-sns';
import {
  awsConfigFromEnv,
  EventPublisher,
  InMemoryEventBus,
  SnsEventPublisher,
} from '@acme/messaging';
import {
  AuditService,
  IdempotencyService,
  OutboxPublisher,
  OutboxService,
  type SqlDb,
} from '@acme/nest-common';
import { BankAdapter } from '../../clients/banks/bank-adapter.js';
import { BankRegistry } from '../../clients/banks/bank-registry.js';
import { SimulatedBankAdapter } from '../../clients/banks/simulated-bank.adapter.js';
import {
  CollateralTermsProvider,
  StaticCollateralTermsProvider,
} from '../../clients/terms/collateral-terms.provider.js';
import { PrismaService } from '../../shared/prisma.service.js';
import { BankWebhookController } from './bank-webhook.controller.js';
import { CustodyController } from './custody.controller.js';
import { CustodyService } from './custody.service.js';
import { InternalCustodyController } from './internal-custody.controller.js';

@Module({
  controllers: [
    CustodyController,
    InternalCustodyController,
    BankWebhookController,
  ],
  providers: [
    CustodyService,
    IdempotencyService,
    AuditService,
    OutboxService,
    {
      provide: CollateralTermsProvider,
      useFactory: () =>
        new StaticCollateralTermsProvider({
          ratioBps: Number(process.env.COLLATERAL_RATIO_BPS ?? 9000),
        }),
    },
    {
      provide: BankAdapter,
      useFactory: () =>
        new SimulatedBankAdapter({
          bankId: 'sim-bank',
          publicKeyPem: (process.env.BANK_SIM_PUBLIC_KEY ?? '').replace(
            /\\n/g,
            '\n',
          ),
        }),
    },
    {
      provide: BankRegistry,
      useFactory: (adapter: BankAdapter) => new BankRegistry([adapter]),
      inject: [BankAdapter],
    },
    {
      provide: EventPublisher,
      useFactory: () =>
        process.env.EVENT_BUS === 'sns'
          ? new SnsEventPublisher(
              new SNSClient(awsConfigFromEnv()),
              process.env.EVENTS_TOPIC_ARN as string,
            )
          : new InMemoryEventBus(),
    },
    {
      provide: OutboxPublisher,
      useFactory: (prisma: PrismaService, publisher: EventPublisher) =>
        new OutboxPublisher(prisma as unknown as SqlDb, publisher, {
          intervalMs: Number(process.env.OUTBOX_INTERVAL_MS ?? 1000),
        }),
      inject: [PrismaService, EventPublisher],
    },
  ],
})
export class CustodyModule {}
