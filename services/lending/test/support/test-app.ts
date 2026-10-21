import { generateKeyPairSync } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { importPKCS8, SignJWT } from 'jose';
import 'dotenv/config';
import { Cache, InMemoryCache } from '@acme/cache';
import { Clock, FixedClock } from '@acme/nest-common';
import { EventConsumer, InMemoryEventBus } from '@acme/messaging';

const issuer = 'https://idp.test';
const audience = 'acme-credit';

const authKeys = generateKeyPairSync('ed25519');
const pem = (
  key: { export: (o: object) => string | Buffer },
  type: 'spki' | 'pkcs8',
) => key.export({ type, format: 'pem' }) as string;

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://lending:lending@localhost:5432/lending_test';
process.env.AUTH_ISSUER = issuer;
process.env.AUTH_AUDIENCE = audience;
process.env.AUTH_PUBLIC_KEY = pem(authKeys.publicKey, 'spki');
process.env.SERVICE_PRIVATE_KEY = pem(authKeys.privateKey, 'pkcs8');
delete process.env.REDIS_URL;
process.env.EVENT_BUS = 'memory';

const { AppModule } = await import('../../src/app.module.js');
const { PrismaService } = await import('../../src/shared/prisma.service.js');
const { CustodyClient } =
  await import('../../src/clients/custody/custody.client.js');
const { FakeCustodyClient } = await import('./fake-custody.client.js');

export interface TestContext {
  app: INestApplication;
  prisma: InstanceType<typeof PrismaService>;
  custody: InstanceType<typeof FakeCustodyClient>;
  cache: InMemoryCache;
  clock: FixedClock;
  bus: InMemoryEventBus;
}

export async function createTestApp(
  env: Record<string, string> = {},
): Promise<TestContext> {
  Object.assign(process.env, env);
  const custody = new FakeCustodyClient();
  const cache = new InMemoryCache();
  const clock = new FixedClock(new Date('2026-01-10T12:00:00Z'));
  const bus = new InMemoryEventBus();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CustodyClient)
    .useValue(custody)
    .overrideProvider(Cache)
    .useValue(cache)
    .overrideProvider(Clock)
    .useValue(clock)
    .overrideProvider(EventConsumer)
    .useValue(bus)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.listen(0);
  return { app, prisma: app.get(PrismaService), custody, cache, clock, bus };
}

export async function resetDatabase(prisma: TestContext['prisma']) {
  await prisma.$executeRawUnsafe(
    'TRUNCATE movements, card_accounts, idempotency_keys, audit_log CASCADE',
  );
}

async function mint(sub: string, principal: 'user' | 'service', scope: string) {
  const key = await importPKCS8(pem(authKeys.privateKey, 'pkcs8'), 'EdDSA');
  return new SignJWT({ scope, principal })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(sub)
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime('5m')
    .sign(key);
}

export const userToken = (sub: string) => mint(sub, 'user', '');
export const serviceToken = (scopes: string[], sub = 'card-network') =>
  mint(sub, 'service', scopes.join(' '));
