import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'reflect-metadata';
import { CreateTopicCommand, SNSClient, SubscribeCommand } from '@aws-sdk/client-sns';
import { CreateQueueCommand, GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Redis } from 'ioredis';
import { importPKCS8, SignJWT } from 'jose';
import request from 'supertest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const issuer = 'https://idp.e2e';
const audience = 'acme-credit';
const pem = (key: { export: (o: object) => string | Buffer }, type: 'spki' | 'pkcs8') => key.export({ type, format: 'pem' }) as string;

const authKeys = generateKeyPairSync('ed25519');
const bankKeys = generateKeyPairSync('ed25519');
const aws = { region: 'us-east-1', endpoint: 'http://localhost:4566', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } };

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!accept(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    last = await read();
  }
  return last;
}

async function token(sub: string, principal: 'user' | 'service', scope = '') {
  const key = await importPKCS8(pem(authKeys.privateKey, 'pkcs8'), 'EdDSA');
  return new SignJWT({ scope, principal })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(sub)
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime('10m')
    .sign(key);
}

describe('custody and lending working together (e2e)', () => {
  let collateral: INestApplication;
  let lending: INestApplication;
  let redis: Redis;
  let collateralUrl: string;
  let lendingUrl: string;

  beforeAll(async () => {
    const sns = new SNSClient(aws);
    const sqs = new SQSClient(aws);
    const suffix = randomUUID().slice(0, 8);
    const topicArn = (await sns.send(new CreateTopicCommand({ Name: `e2e-events-${suffix}` }))).TopicArn as string;
    const queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: `e2e-limit-${suffix}`, Attributes: { VisibilityTimeout: '2' } }))).QueueUrl as string;
    const queueArn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }))).Attributes?.QueueArn as string;
    await sns.send(new SubscribeCommand({ TopicArn: topicArn, Protocol: 'sqs', Endpoint: queueArn, Attributes: { RawMessageDelivery: 'true' } }));

    Object.assign(process.env, {
      AUTH_ISSUER: issuer,
      AUTH_AUDIENCE: audience,
      AUTH_PUBLIC_KEY: pem(authKeys.publicKey, 'spki'),
      SERVICE_PRIVATE_KEY: pem(authKeys.privateKey, 'pkcs8'),
      BANK_SIM_PUBLIC_KEY: pem(bankKeys.publicKey, 'spki'),
      COLLATERAL_RATIO_BPS: '9000',
      OUTBOX_INTERVAL_MS: '100',
      AWS_ENDPOINT_URL: aws.endpoint,
      AWS_REGION: aws.region,
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
    });

    process.env.DATABASE_URL = 'postgresql://collateral:collateral@localhost:5432/collateral_test';
    process.env.EVENT_BUS = 'sns';
    process.env.EVENTS_TOPIC_ARN = topicArn;
    const collateralModule = await import(join(root, 'services/collateral/dist/app.module.js'));
    const collateralPrisma = await import(join(root, 'services/collateral/dist/shared/prisma.service.js'));
    collateral = await NestFactory.create(collateralModule.AppModule, { rawBody: true, logger: false });
    await collateral.listen(0);
    await collateral
      .get(collateralPrisma.PrismaService)
      .$executeRawUnsafe('TRUNCATE custody_movements, deposits, custody_accounts, idempotency_keys, audit_log, outbox_events CASCADE');
    collateralUrl = await collateral.getUrl().then((url: string) => url.replace('[::1]', '127.0.0.1'));

    process.env.DATABASE_URL = 'postgresql://lending:lending@localhost:5432/lending_test';
    process.env.EVENT_BUS = 'sqs';
    process.env.LIMIT_EVENTS_QUEUE_URL = queueUrl;
    process.env.CUSTODY_URL = collateralUrl;
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.LIMIT_REQUEST_TIMEOUT_MS = '3000';
    const lendingModule = await import(join(root, 'services/lending/dist/app.module.js'));
    const lendingPrisma = await import(join(root, 'services/lending/dist/shared/prisma.service.js'));
    lending = await NestFactory.create(lendingModule.AppModule, { logger: false });
    await lending.listen(0);
    await lending
      .get(lendingPrisma.PrismaService)
      .$executeRawUnsafe('TRUNCATE movements, card_accounts, idempotency_keys, audit_log, billing_profiles, statements, statement_outcomes CASCADE');
    lendingUrl = await lending.getUrl().then((url: string) => url.replace('[::1]', '127.0.0.1'));
    redis = new Redis('redis://localhost:6379');
  });

  afterAll(async () => {
    await lending?.close();
    await collateral?.close();
    await redis?.quit();
  });

  const as = async (sub: string) => ({ Authorization: `Bearer ${await token(sub, 'user')}` });
  const asService = async (scopes: string[], sub = 'card-network') => ({ Authorization: `Bearer ${await token(sub, 'service', scopes.join(' '))}` });

  function bankWebhook(reference: string, amount: number, options: { forged?: boolean } = {}) {
    const body = JSON.stringify({ eventId: randomUUID(), reference, amount, currency: 'USD', occurredAt: new Date().toISOString() });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = options.forged ? generateKeyPairSync('ed25519').privateKey : createPrivateKey(pem(bankKeys.privateKey, 'pkcs8'));
    const signature = sign(null, Buffer.from(`${timestamp}.${body}`), key).toString('base64');
    return request(collateralUrl)
      .post('/webhooks/banks/sim-bank')
      .set({ 'content-type': 'application/json', 'x-bank-timestamp': timestamp, 'x-bank-signature': signature })
      .send(body);
  }

  async function deposit(custodyId: string, owner: string, amount: number) {
    const created = await request(collateralUrl)
      .post(`/custody-accounts/${custodyId}/deposits`)
      .set(await as(owner))
      .set('Idempotency-Key', randomUUID())
      .send({ bankId: 'sim-bank', amount });
    expect(created.status).toBe(201);
    expect((await bankWebhook(created.body.reference, amount, { forged: true })).status).toBe(401);
    const confirmed = await bankWebhook(created.body.reference, amount);
    expect(confirmed.status).toBe(200);
  }

  it('runs a card from deposit to closure', async () => {
    const owner = 'customer-e2e';

    const custody = await request(collateralUrl).post('/custody-accounts').set(await as(owner)).set('Idempotency-Key', randomUUID()).send({});
    expect(custody.status).toBe(201);
    const custodyId = custody.body.id as string;

    await deposit(custodyId, owner, 100_000);
    const funded = await request(collateralUrl).get(`/custody-accounts/${custodyId}`).set(await as(owner));
    expect(funded.body).toMatchObject({ heldAmount: 100_000, cupo: 90_000 });

    const stranger = await request(lendingUrl)
      .post('/cards')
      .set(await as('someone-else'))
      .set('Idempotency-Key', randomUUID())
      .send({ custodyAccountId: custodyId, cycleDay: 15 });
    expect(stranger.status).toBe(404);

    const card = await request(lendingUrl)
      .post('/cards')
      .set(await as(owner))
      .set('Idempotency-Key', randomUUID())
      .send({ custodyAccountId: custodyId, cycleDay: 15 });
    expect(card.status).toBe(201);
    expect(card.body).toMatchObject({ status: 'ACTIVE', availableCredit: 90_000 });
    const accountId = card.body.id as string;

    const authorize = async (amount: number) =>
      request(lendingUrl)
        .post(`/accounts/${accountId}/authorizations`)
        .set(await asService(['authorizations:write']))
        .set('Idempotency-Key', randomUUID())
        .send({ amount });

    const burst = await Promise.all(Array.from({ length: 30 }, () => authorize(5_000)));
    expect(burst.filter((r) => r.body.status === 'APPROVED')).toHaveLength(18);
    expect((await authorize(1)).body).toMatchObject({ status: 'DECLINED', reason: 'INSUFFICIENT_CREDIT' });

    const payment = await request(lendingUrl)
      .post(`/accounts/${accountId}/payments`)
      .set(await as(owner))
      .set('Idempotency-Key', randomUUID())
      .send({ amount: 50_000 });
    expect(payment.status).toBe(201);

    await deposit(custodyId, owner, 50_000);
    const raised = await until(
      async () => (await request(lendingUrl).get(`/accounts/${accountId}`).set(await as(owner))).body,
      (view) => view.limit?.cupo === 135_000,
    );
    expect(raised.limit.cupo).toBe(135_000);
    expect(raised.availableCredit).toBe(95_000);
    const cached = await redis.hgetall(`limit:${custodyId}`);
    expect(Number(cached.version)).toBe(2);

    const reduction = await request(lendingUrl)
      .post(`/accounts/${accountId}/limit-reduction`)
      .set(await as(owner))
      .set('Idempotency-Key', randomUUID())
      .send({ newCupo: 80_000 });
    expect(reduction.status).toBe(200);
    expect(reduction.body).toEqual({ status: 'APPLIED', newCupo: 80_000 });
    const reduced = await request(collateralUrl).get(`/custody-accounts/${custodyId}`).set(await as(owner));
    expect(reduced.body).toMatchObject({ heldAmount: 88_889, cupo: 80_000 });
    const afterReduction = await request(lendingUrl).get(`/accounts/${accountId}`).set(await as(owner));
    expect(afterReduction.body.limit.cupo).toBe(80_000);
    expect(afterReduction.body.availableCredit).toBe(40_000);
    expect((await authorize(40_001)).body.status).toBe('DECLINED');

    const jobs = await request(lendingUrl)
      .post('/internal/jobs/daily')
      .set(await asService(['jobs:run'], 'scheduler'));
    expect(jobs.status).toBe(201);

    const closure = await request(lendingUrl)
      .post(`/accounts/${accountId}/closure`)
      .set(await as(owner))
      .set('Idempotency-Key', randomUUID())
      .send();
    expect(closure.status).toBe(200);
    expect(closure.body).toEqual({ status: 'CLOSED', debt: 0 });

    const settled = await request(collateralUrl).get(`/custody-accounts/${custodyId}`).set(await as(owner));
    expect(settled.body).toMatchObject({ status: 'CLOSED', heldAmount: 0 });
    const closedCard = await request(lendingUrl).get(`/accounts/${accountId}`).set(await as(owner));
    expect(closedCard.body).toMatchObject({ status: 'CLOSED', balances: { debt: 0 } });
    expect((await authorize(1)).body).toMatchObject({ status: 'DECLINED', reason: 'ACCOUNT_NOT_ACTIVE' });
  });
});
