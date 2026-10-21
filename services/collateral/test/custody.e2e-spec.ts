import request from 'supertest';
import { SCOPES } from '@acme/contracts';
import {
  createTestApp,
  resetDatabase,
  serviceToken,
  signBankWebhook,
  userToken,
  type TestContext,
} from './support/test-app.js';

describe('collateral service (e2e)', () => {
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
    ctx.bus.published.length = 0;
  });

  async function openAccount(owner = 'user-1', key = crypto.randomUUID()) {
    const res = await http()
      .post('/custody-accounts')
      .set('Authorization', `Bearer ${await userToken(owner)}`)
      .set('Idempotency-Key', key)
      .send({});
    expect(res.status).toBe(201);
    return res.body as { id: string };
  }

  async function createDeposit(
    accountId: string,
    amount: number,
    owner = 'user-1',
  ) {
    const res = await http()
      .post(`/custody-accounts/${accountId}/deposits`)
      .set('Authorization', `Bearer ${await userToken(owner)}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ bankId: 'sim-bank', amount });
    expect(res.status).toBe(201);
    return res.body as { depositId: string; reference: string };
  }

  function webhook(
    reference: string,
    amount: number,
    eventId = crypto.randomUUID(),
    options?: Parameters<typeof signBankWebhook>[1],
  ) {
    const { raw, headers } = signBankWebhook(
      {
        eventId,
        reference,
        amount,
        currency: 'USD',
        occurredAt: '2026-01-01T00:00:00.000Z',
      },
      options,
    );
    return http().post('/webhooks/banks/sim-bank').set(headers).send(raw);
  }

  async function fundedAccount(amount = 100_000) {
    const account = await openAccount();
    const deposit = await createDeposit(account.id, amount);
    expect((await webhook(deposit.reference, amount)).status).toBe(200);
    return account;
  }

  describe('authentication', () => {
    it('serves health without a token', async () => {
      await http().get('/health').expect(200, { status: 'ok' });
    });

    it('rejects missing tokens and wrong principals', async () => {
      await http()
        .post('/custody-accounts')
        .set('Idempotency-Key', 'k')
        .send({})
        .expect(401);
      await http()
        .post('/custody-accounts')
        .set(
          'Authorization',
          `Bearer ${await serviceToken([SCOPES.custodyRead])}`,
        )
        .set('Idempotency-Key', 'k')
        .send({})
        .expect(403);
    });

    it('requires the right scope for internal endpoints', async () => {
      const account = await openAccount();
      await http()
        .get(`/custody-accounts/${account.id}/limit`)
        .set('Authorization', `Bearer ${await serviceToken([])}`)
        .expect(403);
      await http()
        .get(`/custody-accounts/${account.id}/limit`)
        .set('Authorization', `Bearer ${await userToken('user-1')}`)
        .expect(403);
    });
  });

  describe('accounts', () => {
    it('replays the same response for the same idempotency key', async () => {
      const key = crypto.randomUUID();
      const first = await openAccount('user-1', key);
      const second = await openAccount('user-1', key);
      expect(second.id).toBe(first.id);
      expect(await ctx.prisma.custodyAccount.count()).toBe(1);
    });

    it('rejects an idempotency key reused with a different request', async () => {
      const key = crypto.randomUUID();
      await openAccount('user-1', key);
      const res = await http()
        .post('/custody-accounts')
        .set('Authorization', `Bearer ${await userToken('user-1')}`)
        .set('Idempotency-Key', key)
        .send({ currency: 'EUR' });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('requires an idempotency key', async () => {
      await http()
        .post('/custody-accounts')
        .set('Authorization', `Bearer ${await userToken('user-1')}`)
        .send({})
        .expect(400);
    });

    it('hides accounts that belong to other users', async () => {
      const account = await openAccount('user-1');
      await http()
        .get(`/custody-accounts/${account.id}`)
        .set('Authorization', `Bearer ${await userToken('user-2')}`)
        .expect(404);
      await http()
        .post(`/custody-accounts/${account.id}/deposits`)
        .set('Authorization', `Bearer ${await userToken('user-2')}`)
        .set('Idempotency-Key', 'k')
        .send({ bankId: 'sim-bank', amount: 100 })
        .expect(404);
      await http()
        .get(`/custody-accounts/${account.id}`)
        .set('Authorization', `Bearer ${await userToken('user-1')}`)
        .expect(200);
    });

    it('validates input', async () => {
      const account = await openAccount();
      const post = async (body: object) =>
        http()
          .post(`/custody-accounts/${account.id}/deposits`)
          .set('Authorization', `Bearer ${await userToken('user-1')}`)
          .set('Idempotency-Key', crypto.randomUUID())
          .send(body);
      expect((await post({ bankId: 'sim-bank', amount: 10.5 })).status).toBe(
        400,
      );
      expect((await post({ bankId: 'sim-bank', amount: -5 })).status).toBe(400);
      expect(
        (await post({ bankId: 'sim-bank', amount: 5, extra: true })).status,
      ).toBe(400);
      expect((await post({ bankId: 'unknown', amount: 5 })).status).toBe(404);
    });
  });

  describe('deposit confirmation webhook', () => {
    it('credits the account, derives the cupo and publishes the limit event', async () => {
      const account = await openAccount();
      const deposit = await createDeposit(account.id, 100_000);
      const res = await webhook(deposit.reference, 100_000);
      expect(res.status).toBe(200);

      const view = await http()
        .get(`/custody-accounts/${account.id}`)
        .set('Authorization', `Bearer ${await userToken('user-1')}`);
      expect(view.body).toMatchObject({
        heldAmount: 100_000,
        cupo: 90_000,
        limitVersion: 1,
      });

      const limit = await http()
        .get(`/custody-accounts/${account.id}/limit`)
        .set(
          'Authorization',
          `Bearer ${await serviceToken([SCOPES.custodyRead])}`,
        );
      expect(limit.body).toMatchObject({
        cupo: 90_000,
        version: 1,
        ownerId: 'user-1',
      });

      expect(await ctx.outbox.drain()).toBe(1);
      expect(ctx.bus.published).toHaveLength(1);
      expect(ctx.bus.published[0]).toMatchObject({
        type: 'custody.limit-changed',
        payload: { custodyAccountId: account.id, version: 1 },
      });
      expect(await ctx.outbox.drain()).toBe(0);
    });

    it('rejects bad signatures, tampered bodies and stale timestamps', async () => {
      const account = await openAccount();
      const deposit = await createDeposit(account.id, 5_000);
      expect(
        (await webhook(deposit.reference, 5_000, undefined, { tamper: true }))
          .status,
      ).toBe(401);
      expect(
        (
          await webhook(deposit.reference, 5_000, undefined, {
            timestamp: Math.floor(Date.now() / 1000) - 3_600,
          })
        ).status,
      ).toBe(401);
      const unsigned = await http()
        .post('/webhooks/banks/sim-bank')
        .send({ reference: deposit.reference });
      expect(unsigned.status).toBe(401);
      expect(
        (await http().post('/webhooks/banks/other-bank').send({})).status,
      ).toBe(404);
      expect(
        (
          await ctx.prisma.custodyAccount.findUniqueOrThrow({
            where: { id: account.id },
          })
        ).heldAmount,
      ).toBe(0n);
    });

    it('is idempotent per bank event id', async () => {
      const account = await openAccount();
      const deposit = await createDeposit(account.id, 5_000);
      const eventId = crypto.randomUUID();
      const first = await webhook(deposit.reference, 5_000, eventId);
      const second = await webhook(deposit.reference, 5_000, eventId);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(
        (
          await ctx.prisma.custodyAccount.findUniqueOrThrow({
            where: { id: account.id },
          })
        ).heldAmount,
      ).toBe(5_000n);
      expect(await ctx.prisma.custodyMovement.count()).toBe(1);
    });

    it('does not credit a deposit twice with a different event id', async () => {
      const account = await openAccount();
      const deposit = await createDeposit(account.id, 5_000);
      expect((await webhook(deposit.reference, 5_000)).status).toBe(200);
      const again = await webhook(deposit.reference, 5_000);
      expect(again.status).toBe(409);
      expect(
        (
          await ctx.prisma.custodyAccount.findUniqueOrThrow({
            where: { id: account.id },
          })
        ).heldAmount,
      ).toBe(5_000n);
    });

    it('rejects mismatches and unknown references and audits the rejection', async () => {
      const account = await openAccount();
      const deposit = await createDeposit(account.id, 5_000);
      const mismatch = await webhook(deposit.reference, 4_999);
      expect(mismatch.status).toBe(422);
      expect(mismatch.body.code).toBe('DEPOSIT_AMOUNT_MISMATCH');
      expect((await webhook('DEP-UNKNOWN', 5_000)).status).toBe(404);
      const audits = await ctx.prisma.auditLog.findMany({
        where: { action: 'custody.deposit.rejected' },
      });
      expect(
        audits.map((a) => (a.data as { code: string }).code).sort(),
      ).toEqual(['DEPOSIT_AMOUNT_MISMATCH', 'DEPOSIT_NOT_FOUND']);
      expect(
        (
          await ctx.prisma.deposit.findUniqueOrThrow({
            where: { id: deposit.depositId },
          })
        ).status,
      ).toBe('PENDING');
    });

    it('does not lose updates when many deposits are confirmed concurrently', async () => {
      const account = await openAccount();
      const deposits = await Promise.all(
        Array.from({ length: 15 }, () => createDeposit(account.id, 1_000)),
      );
      const results = await Promise.all(
        deposits.map((d) => webhook(d.reference, 1_000)),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      const stored = await ctx.prisma.custodyAccount.findUniqueOrThrow({
        where: { id: account.id },
      });
      expect(stored.heldAmount).toBe(15_000n);
      expect(stored.limitVersion).toBe(15);
      expect(await ctx.prisma.custodyMovement.count()).toBe(15);
    });

    it('credits once when the same event is delivered concurrently', async () => {
      const account = await openAccount();
      const deposit = await createDeposit(account.id, 2_000);
      const eventId = crypto.randomUUID();
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          webhook(deposit.reference, 2_000, eventId),
        ),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(
        (
          await ctx.prisma.custodyAccount.findUniqueOrThrow({
            where: { id: account.id },
          })
        ).heldAmount,
      ).toBe(2_000n);
    });
  });

  describe('settlement', () => {
    const settle = async (
      accountId: string,
      applyAmount: number,
      key = crypto.randomUUID(),
    ) =>
      http()
        .post(`/custody-accounts/${accountId}/settlements`)
        .set(
          'Authorization',
          `Bearer ${await serviceToken([SCOPES.custodySettle])}`,
        )
        .set('Idempotency-Key', key)
        .send({ applyAmount });

    it('applies the debt, releases the rest and closes the account', async () => {
      const account = await fundedAccount(100_000);
      const res = await settle(account.id, 30_000);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ applied: 30_000, released: 70_000 });
      const stored = await ctx.prisma.custodyAccount.findUniqueOrThrow({
        where: { id: account.id },
      });
      expect(stored).toMatchObject({ heldAmount: 0n, status: 'CLOSED' });
      const movements = await ctx.prisma.custodyMovement.findMany({
        where: { custodyAccountId: account.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(movements.map((m) => [m.type, m.amount])).toEqual([
        ['DEPOSIT', 100_000n],
        ['APPLIED', 30_000n],
        ['RELEASE', 70_000n],
      ]);
    });

    it('caps the applied amount at what is held', async () => {
      const account = await fundedAccount(10_000);
      const res = await settle(account.id, 25_000);
      expect(res.body).toEqual({ applied: 10_000, released: 0 });
    });

    it('releases everything when there is no debt', async () => {
      const account = await fundedAccount(10_000);
      expect((await settle(account.id, 0)).body).toEqual({
        applied: 0,
        released: 10_000,
      });
    });

    it('is idempotent and rejects a second settlement', async () => {
      const account = await fundedAccount(10_000);
      const key = crypto.randomUUID();
      const first = await settle(account.id, 4_000, key);
      const replay = await settle(account.id, 4_000, key);
      expect(replay.body).toEqual(first.body);
      expect((await settle(account.id, 4_000)).status).toBe(409);
      expect(await ctx.prisma.custodyMovement.count()).toBe(3);
    });

    it('settles once under concurrent attempts with different keys', async () => {
      const account = await fundedAccount(10_000);
      const results = await Promise.all(
        Array.from({ length: 6 }, () => settle(account.id, 4_000)),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    });

    it('requires the settle scope', async () => {
      const account = await fundedAccount(10_000);
      await http()
        .post(`/custody-accounts/${account.id}/settlements`)
        .set(
          'Authorization',
          `Bearer ${await serviceToken([SCOPES.custodyRead])}`,
        )
        .set('Idempotency-Key', 'k')
        .send({ applyAmount: 1 })
        .expect(403);
    });
  });

  describe('limit reduction', () => {
    const reduce = async (
      accountId: string,
      newCupo: number,
      key = crypto.randomUUID(),
    ) =>
      http()
        .post(`/custody-accounts/${accountId}/limit-reductions`)
        .set(
          'Authorization',
          `Bearer ${await serviceToken([SCOPES.custodySettle])}`,
        )
        .set('Idempotency-Key', key)
        .send({ newCupo });

    it('releases the collateral that is no longer needed', async () => {
      const account = await fundedAccount(100_000);
      const res = await reduce(account.id, 45_000);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ cupo: 45_000, version: 2, released: 50_000 });
      expect(
        (
          await ctx.prisma.custodyAccount.findUniqueOrThrow({
            where: { id: account.id },
          })
        ).heldAmount,
      ).toBe(50_000n);
    });

    it('rounds the retained collateral up so the cupo never falls below the request', async () => {
      const account = await fundedAccount(100_000);
      const res = await reduce(account.id, 10_001);
      expect(res.body.cupo).toBeGreaterThanOrEqual(10_001);
    });

    it('rejects changes that do not reduce', async () => {
      const account = await fundedAccount(100_000);
      const res = await reduce(account.id, 90_000);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('NOT_A_REDUCTION');
    });
  });

  describe('database guarantees', () => {
    it('refuses to modify or delete journal rows', async () => {
      await fundedAccount(1_000);
      await expect(
        ctx.prisma.$executeRawUnsafe('UPDATE custody_movements SET amount = 1'),
      ).rejects.toThrow();
      await expect(
        ctx.prisma.$executeRawUnsafe('DELETE FROM custody_movements'),
      ).rejects.toThrow();
      await expect(
        ctx.prisma.$executeRawUnsafe('DELETE FROM audit_log'),
      ).rejects.toThrow();
    });

    it('refuses a negative held amount', async () => {
      const account = await openAccount();
      await expect(
        ctx.prisma.$executeRawUnsafe(
          `UPDATE custody_accounts SET held_amount = -1 WHERE id = '${account.id}'::uuid`,
        ),
      ).rejects.toThrow();
    });
  });
});
