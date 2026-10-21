import {
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { importPKCS8, SignJWT } from 'jose';
import 'dotenv/config';
import { InMemoryEventBus, EventPublisher } from '@acme/messaging';
import { OutboxPublisher } from '@acme/nest-common';

const issuer = 'https://idp.test';
const audience = 'acme-credit';

const authKeys = generateKeyPairSync('ed25519');
const bankKeys = generateKeyPairSync('ed25519');
const pem = (
  key: { export: (o: object) => string | Buffer },
  type: 'spki' | 'pkcs8',
) => key.export({ type, format: 'pem' }) as string;

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://collateral:collateral@localhost:5432/collateral_test';
process.env.AUTH_ISSUER = issuer;
process.env.AUTH_AUDIENCE = audience;
process.env.AUTH_PUBLIC_KEY = pem(authKeys.publicKey, 'spki');
process.env.BANK_SIM_PUBLIC_KEY = pem(bankKeys.publicKey, 'spki');
process.env.BANK_HMAC_SECRET = 'hmac-test-secret-0123456789';
process.env.COLLATERAL_RATIO_BPS = '9000';
process.env.OUTBOX_INTERVAL_MS = '0';

const { AppModule } = await import('../../src/app.module.js');
const { PrismaService } = await import('../../src/shared/prisma.service.js');

export interface TestContext {
  app: INestApplication;
  bus: InMemoryEventBus;
  prisma: InstanceType<typeof PrismaService>;
  outbox: OutboxPublisher;
}

export async function createTestApp(): Promise<TestContext> {
  const bus = new InMemoryEventBus();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EventPublisher)
    .useValue(bus)
    .compile();
  const app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  await app.listen(0);
  return {
    app,
    bus,
    prisma: app.get(PrismaService),
    outbox: app.get(OutboxPublisher),
  };
}

export async function resetDatabase(prisma: TestContext['prisma']) {
  await prisma.$executeRawUnsafe(
    'TRUNCATE custody_movements, deposits, custody_accounts, idempotency_keys, audit_log, outbox_events CASCADE',
  );
}

async function mint(
  sub: string,
  principal: 'user' | 'service',
  scope: string,
  expiresIn = '5m',
) {
  const key = await importPKCS8(pem(authKeys.privateKey, 'pkcs8'), 'EdDSA');
  return new SignJWT({ scope, principal })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(sub)
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime(expiresIn)
    .sign(key);
}

export const userToken = (sub: string) => mint(sub, 'user', '');
export const serviceToken = (scopes: string[], sub = 'lending') =>
  mint(sub, 'service', scopes.join(' '));

export function signBankWebhook(
  body: object,
  options: { timestamp?: number; tamper?: boolean } = {},
) {
  const raw = JSON.stringify(body);
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = sign(
    null,
    Buffer.from(`${timestamp}.${raw}`),
    createPrivateKey(pem(bankKeys.privateKey, 'pkcs8')),
  ).toString('base64');
  return {
    raw: options.tamper ? raw.replace(/\d+/, '999') : raw,
    headers: {
      'content-type': 'application/json',
      'x-bank-timestamp': timestamp,
      'x-bank-signature': signature,
    },
  };
}

export const HMAC_SECRET = 'hmac-test-secret-0123456789';

export function signHmacWebhook(
  body: object,
  options: { timestamp?: number; secret?: string; tamper?: boolean } = {},
) {
  const raw = JSON.stringify(body);
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', options.secret ?? HMAC_SECRET)
    .update(`${timestamp}.${raw}`)
    .digest('hex');
  return {
    raw: options.tamper ? raw.replace(/\d+/, '999') : raw,
    headers: {
      'content-type': 'application/json',
      'x-bank-timestamp': timestamp,
      'x-bank-signature': signature,
    },
  };
}
