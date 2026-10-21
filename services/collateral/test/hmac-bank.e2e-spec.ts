import request from 'supertest';
import {
  createTestApp,
  resetDatabase,
  signHmacWebhook,
  userToken,
  type TestContext,
} from './support/test-app.js';

describe('HMAC bank webhooks (e2e)', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
  });

  async function pendingDeposit(amount = 10_000) {
    const account = await http()
      .post('/custody-accounts')
      .set('Authorization', `Bearer ${await userToken('user-1')}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({});
    const deposit = await http()
      .post(`/custody-accounts/${account.body.id}/deposits`)
      .set('Authorization', `Bearer ${await userToken('user-1')}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ bankId: 'hmac-bank', amount });
    expect(deposit.status).toBe(201);
    return {
      accountId: account.body.id as string,
      reference: deposit.body.reference as string,
      amount,
    };
  }

  const payload = (
    reference: string,
    amount: number,
    eventId = crypto.randomUUID(),
  ) => ({
    eventId,
    reference,
    amount,
    currency: 'USD',
    occurredAt: '2026-01-01T00:00:00.000Z',
  });

  const send = (
    body: object,
    options?: Parameters<typeof signHmacWebhook>[1],
  ) => {
    const { raw, headers } = signHmacWebhook(body, options);
    return http().post('/webhooks/banks/hmac-bank').set(headers).send(raw);
  };

  it('confirms a deposit signed with the shared secret', async () => {
    const { accountId, reference, amount } = await pendingDeposit();
    const res = await send(payload(reference, amount));
    expect(res.status).toBe(200);
    const account = await ctx.prisma.custodyAccount.findUniqueOrThrow({
      where: { id: accountId },
    });
    expect(account.heldAmount).toBe(10_000n);
  });

  it('rejects a wrong secret, a tampered body, a stale timestamp and missing headers', async () => {
    const { reference, amount } = await pendingDeposit();
    expect(
      (
        await send(payload(reference, amount), {
          secret: 'another-secret-0123456789',
        })
      ).status,
    ).toBe(401);
    expect(
      (await send(payload(reference, amount), { tamper: true })).status,
    ).toBe(401);
    expect(
      (
        await send(payload(reference, amount), {
          timestamp: Math.floor(Date.now() / 1000) - 3_600,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await http()
          .post('/webhooks/banks/hmac-bank')
          .send(payload(reference, amount))
      ).status,
    ).toBe(401);
    expect((await ctx.prisma.deposit.findFirstOrThrow()).status).toBe(
      'PENDING',
    );
  });

  it('is idempotent per event id and rejects a malformed signature without throwing', async () => {
    const { reference, amount, accountId } = await pendingDeposit();
    const eventId = crypto.randomUUID();
    const first = await send(payload(reference, amount, eventId));
    const second = await send(payload(reference, amount, eventId));
    expect(second.body).toEqual(first.body);
    expect(
      (
        await ctx.prisma.custodyAccount.findUniqueOrThrow({
          where: { id: accountId },
        })
      ).heldAmount,
    ).toBe(10_000n);

    const { raw } = signHmacWebhook(payload(reference, amount));
    const bad = await http()
      .post('/webhooks/banks/hmac-bank')
      .set({
        'content-type': 'application/json',
        'x-bank-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-bank-signature': 'zz',
      })
      .send(raw);
    expect(bad.status).toBe(401);
  });

  it('does not accept a signature scheme that belongs to another bank', async () => {
    const { reference, amount } = await pendingDeposit();
    const res = await http()
      .post('/webhooks/banks/sim-bank')
      .set(signHmacWebhook(payload(reference, amount)).headers)
      .send(JSON.stringify(payload(reference, amount)));
    expect(res.status).toBe(401);
  });
});
