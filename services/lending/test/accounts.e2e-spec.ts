import request from 'supertest';
import { SCOPES } from '@acme/contracts';
import {
  createTestApp,
  resetDatabase,
  serviceToken,
  userToken,
  type TestContext,
} from './support/test-app.js';

describe('lending accounts (e2e)', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());
  const CUSTODY_ID = '11111111-1111-4111-8111-111111111111';

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ctx.clock.set(new Date('2026-01-10T12:00:00Z'));
    await ctx.cache.delete(`limit:${CUSTODY_ID}`);
    ctx.custody.accounts.clear();
    ctx.custody.down = false;
    ctx.custody.calls = 0;
    ctx.custody.seed(CUSTODY_ID, 'user-1', 100_000);
  });

  async function openCard(
    owner = 'user-1',
    custodyId = CUSTODY_ID,
    cycleDay = 1,
    key = crypto.randomUUID(),
  ) {
    return http()
      .post('/cards')
      .set('Authorization', `Bearer ${await userToken(owner)}`)
      .set('Idempotency-Key', key)
      .send({ custodyAccountId: custodyId, cycleDay });
  }

  async function card() {
    const res = await openCard();
    expect(res.status).toBe(201);
    return res.body as { id: string };
  }

  async function authorize(
    accountId: string,
    amount: number,
    key = crypto.randomUUID(),
  ) {
    return http()
      .post(`/accounts/${accountId}/authorizations`)
      .set(
        'Authorization',
        `Bearer ${await serviceToken([SCOPES.authorizationsWrite])}`,
      )
      .set('Idempotency-Key', key)
      .send({ amount });
  }

  async function pay(
    accountId: string,
    amount: number,
    owner = 'user-1',
    key = crypto.randomUUID(),
  ) {
    return http()
      .post(`/accounts/${accountId}/payments`)
      .set('Authorization', `Bearer ${await userToken(owner)}`)
      .set('Idempotency-Key', key)
      .send({ amount });
  }

  async function view(accountId: string, owner = 'user-1') {
    const res = await http()
      .get(`/accounts/${accountId}`)
      .set('Authorization', `Bearer ${await userToken(owner)}`);
    return res;
  }

  async function assertJournalMatchesBalances(accountId: string) {
    const account = await ctx.prisma.cardAccount.findUniqueOrThrow({
      where: { id: accountId },
    });
    const movements = await ctx.prisma.movement.findMany({
      where: { accountId },
    });
    const sum = (bucket: string) =>
      movements
        .filter((m) => m.bucket === bucket)
        .reduce(
          (total, m) =>
            total + (m.direction === 'DEBIT' ? m.amount : -m.amount),
          0n,
        );
    expect(account.principal).toBe(sum('PRINCIPAL'));
    expect(account.interest).toBe(sum('INTEREST'));
    expect(account.fees).toBe(sum('FEES'));
    expect(account.deferred).toBe(sum('DEFERRED'));
  }

  describe('health', () => {
    it('reports readiness when the database answers', async () => {
      await http().get('/health/ready').expect(200, { status: 'ready' });
    });
  });

  describe('requesting a card', () => {
    it('creates an active card with a limit derived from the custody account', async () => {
      const res = await openCard();
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'ACTIVE',
        cycleDay: 1,
        availableCredit: 90_000,
        limit: { cupo: 90_000 },
      });
    });

    it('is idempotent and allows one card per custody account', async () => {
      const key = crypto.randomUUID();
      const first = await openCard('user-1', CUSTODY_ID, 1, key);
      const replay = await openCard('user-1', CUSTODY_ID, 1, key);
      expect(replay.body.id).toBe(first.body.id);
      const second = await openCard('user-1', CUSTODY_ID, 1);
      expect(second.status).toBe(409);
      expect(await ctx.prisma.cardAccount.count()).toBe(1);
    });

    it('rejects custody accounts owned by someone else, unknown or without collateral', async () => {
      expect((await openCard('user-2')).status).toBe(404);
      expect(
        (await openCard('user-1', '22222222-2222-4222-8222-222222222222'))
          .status,
      ).toBe(404);
      ctx.custody.seed('33333333-3333-4333-8333-333333333333', 'user-1', 0);
      const empty = await openCard(
        'user-1',
        '33333333-3333-4333-8333-333333333333',
      );
      expect(empty.status).toBe(422);
      expect(empty.body.code).toBe('NO_COLLATERAL');
    });

    it('only accepts cut-off days 1 and 15', async () => {
      expect((await openCard('user-1', CUSTODY_ID, 7)).status).toBe(400);
      expect((await openCard('user-1', CUSTODY_ID, 15)).status).toBe(201);
    });

    it('reports custody downtime as 503', async () => {
      ctx.custody.down = true;
      expect((await openCard()).status).toBe(503);
    });
  });

  describe('authorizations', () => {
    it('approves purchases within the available credit and declines the rest', async () => {
      const { id } = await card();
      const ok = await authorize(id, 60_000);
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({
        status: 'APPROVED',
        availableCredit: 30_000,
      });
      const declined = await authorize(id, 30_001);
      expect(declined.status).toBe(200);
      expect(declined.body).toMatchObject({
        status: 'DECLINED',
        reason: 'INSUFFICIENT_CREDIT',
        availableCredit: 30_000,
      });
      expect((await authorize(id, 30_000)).body.status).toBe('APPROVED');
      expect((await view(id)).body).toMatchObject({
        availableCredit: 0,
        balances: { principal: 90_000, debt: 90_000 },
      });
      await assertJournalMatchesBalances(id);
    });

    it('replays the stored decision for the same idempotency key', async () => {
      const { id } = await card();
      const key = crypto.randomUUID();
      const first = await authorize(id, 10_000, key);
      const replay = await authorize(id, 10_000, key);
      expect(replay.status).toBe(first.status);
      expect(replay.body).toEqual(first.body);
      expect(await ctx.prisma.movement.count()).toBe(1);
      const reused = await authorize(id, 10_001, key);
      expect(reused.status).toBe(422);
    });

    it('never exceeds the limit under concurrent purchases', async () => {
      const { id } = await card();
      const results = await Promise.all(
        Array.from({ length: 40 }, () => authorize(id, 7_000)),
      );
      const approved = results.filter(
        (r) => r.body.status === 'APPROVED',
      ).length;
      expect(approved).toBe(12);
      expect(results.filter((r) => r.body.status === 'DECLINED')).toHaveLength(
        28,
      );
      const account = await ctx.prisma.cardAccount.findUniqueOrThrow({
        where: { id },
      });
      expect(account.principal).toBe(84_000n);
      await assertJournalMatchesBalances(id);
    });

    it('charges a retried request only once under concurrency', async () => {
      const { id } = await card();
      const key = crypto.randomUUID();
      const results = await Promise.all(
        Array.from({ length: 10 }, () => authorize(id, 5_000, key)),
      );
      expect(new Set(results.map((r) => r.body.authorizationId)).size).toBe(1);
      expect(await ctx.prisma.movement.count()).toBe(1);
    });

    it('declines when the account is not active', async () => {
      const { id } = await card();
      await ctx.prisma.cardAccount.update({
        where: { id },
        data: { status: 'DELINQUENT' },
      });
      expect((await authorize(id, 100)).body).toMatchObject({
        status: 'DECLINED',
        reason: 'ACCOUNT_NOT_ACTIVE',
      });
    });

    it('respects the own cap while a reduction is in progress', async () => {
      const { id } = await card();
      await ctx.prisma.cardAccount.update({
        where: { id },
        data: { limitCap: 20_000n },
      });
      expect((await authorize(id, 20_001)).body.status).toBe('DECLINED');
      expect((await authorize(id, 20_000)).body.status).toBe('APPROVED');
    });

    it('requires the authorizations scope and a service principal', async () => {
      const { id } = await card();
      await http()
        .post(`/accounts/${id}/authorizations`)
        .set('Authorization', `Bearer ${await userToken('user-1')}`)
        .set('Idempotency-Key', 'k')
        .send({ amount: 1 })
        .expect(403);
      await http()
        .post(`/accounts/${id}/authorizations`)
        .set('Authorization', `Bearer ${await serviceToken([])}`)
        .set('Idempotency-Key', 'k')
        .send({ amount: 1 })
        .expect(403);
      await http()
        .post(`/accounts/${id}/authorizations`)
        .set('Idempotency-Key', 'k')
        .send({ amount: 1 })
        .expect(401);
    });

    it('validates amounts', async () => {
      const { id } = await card();
      expect((await authorize(id, 0)).status).toBe(400);
      expect((await authorize(id, 12.5)).status).toBe(400);
      expect((await authorize(id, -1)).status).toBe(400);
    });

    it('returns 404 for unknown accounts', async () => {
      expect(
        (await authorize('44444444-4444-4444-8444-444444444444', 100)).status,
      ).toBe(404);
    });
  });

  describe('limit resolution', () => {
    it('serves the limit from the cache and only calls custody once', async () => {
      const { id } = await card();
      ctx.custody.calls = 0;
      await authorize(id, 100);
      await authorize(id, 100);
      expect(ctx.custody.calls).toBe(0);
    });

    it('denies purchases when the cache expired and custody is down (deny policy)', async () => {
      const { id } = await card();
      ctx.clock.advanceDays(1);
      ctx.custody.down = true;
      const res = await authorize(id, 100);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('LIMIT_UNAVAILABLE');
      expect(await ctx.prisma.movement.count()).toBe(0);
    });

    it('refreshes an expired limit from custody', async () => {
      const { id } = await card();
      ctx.custody.setHeld(CUSTODY_ID, 200_000);
      ctx.clock.advanceDays(1);
      const res = await authorize(id, 150_000);
      expect(res.body.status).toBe('APPROVED');
    });

    it('applies a limit-changed event', async () => {
      const { id } = await card();
      ctx.custody.setHeld(CUSTODY_ID, 200_000);
      await ctx.bus.start();
      await ctx.bus.publish({
        id: crypto.randomUUID(),
        type: 'custody.limit-changed',
        version: 1,
        occurredAt: new Date().toISOString(),
        payload: { custodyAccountId: CUSTODY_ID, version: 2 },
      });
      expect((await authorize(id, 150_000)).body.status).toBe('APPROVED');
    });
  });

  describe('reversals', () => {
    async function reverse(
      accountId: string,
      authorizationId: string,
      key = crypto.randomUUID(),
    ) {
      return http()
        .post(
          `/accounts/${accountId}/authorizations/${authorizationId}/reversals`,
        )
        .set(
          'Authorization',
          `Bearer ${await serviceToken([SCOPES.authorizationsWrite])}`,
        )
        .set('Idempotency-Key', key)
        .send();
    }

    it('restores the credit and can only happen once', async () => {
      const { id } = await card();
      const auth = (await authorize(id, 40_000)).body.authorizationId;
      const key = crypto.randomUUID();
      expect((await reverse(id, auth, key)).status).toBe(201);
      expect((await reverse(id, auth, key)).status).toBe(201);
      const again = await reverse(id, auth);
      expect(again.status).toBe(409);
      expect((await view(id)).body.availableCredit).toBe(90_000);
      await assertJournalMatchesBalances(id);
    });

    it('does not reverse unknown authorizations or ones already paid', async () => {
      const { id } = await card();
      expect(
        (await reverse(id, '55555555-5555-4555-8555-555555555555')).status,
      ).toBe(404);
      const auth = (await authorize(id, 10_000)).body.authorizationId;
      await pay(id, 10_000);
      const res = await reverse(id, auth);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('REVERSAL_EXCEEDS_BALANCE');
    });

    it('reverses only once under concurrency', async () => {
      const { id } = await card();
      const auth = (await authorize(id, 10_000)).body.authorizationId;
      const results = await Promise.all(
        Array.from({ length: 6 }, () => reverse(id, auth)),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(
        await ctx.prisma.movement.count({ where: { type: 'REVERSAL' } }),
      ).toBe(1);
    });
  });

  describe('payments', () => {
    it('restores the available credit', async () => {
      const { id } = await card();
      await authorize(id, 50_000);
      const res = await pay(id, 20_000);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        applied: [{ bucket: 'PRINCIPAL', amount: 20_000 }],
        debt: 30_000,
      });
      expect((await view(id)).body.availableCredit).toBe(60_000);
    });

    it('applies payments to fees, then interest, then principal', async () => {
      const { id } = await card();
      await authorize(id, 50_000);
      await ctx.prisma.cardAccount.update({
        where: { id },
        data: { fees: 1_500n, interest: 4_000n },
      });
      const res = await pay(id, 10_000);
      expect(res.body.applied).toEqual([
        { bucket: 'FEES', amount: 1_500 },
        { bucket: 'INTEREST', amount: 4_000 },
        { bucket: 'PRINCIPAL', amount: 4_500 },
      ]);
      const stored = await ctx.prisma.cardAccount.findUniqueOrThrow({
        where: { id },
      });
      expect([stored.fees, stored.interest, stored.principal]).toEqual([
        0n,
        0n,
        45_500n,
      ]);
    });

    it('rejects payments larger than the debt and for other owners', async () => {
      const { id } = await card();
      await authorize(id, 5_000);
      const over = await pay(id, 5_001);
      expect(over.status).toBe(422);
      expect(over.body.code).toBe('PAYMENT_EXCEEDS_DEBT');
      expect((await pay(id, 100, 'user-2')).status).toBe(404);
    });

    it('is idempotent', async () => {
      const { id } = await card();
      await authorize(id, 5_000);
      const key = crypto.randomUUID();
      const first = await pay(id, 2_000, 'user-1', key);
      const replay = await pay(id, 2_000, 'user-1', key);
      expect(replay.body).toEqual(first.body);
      expect((await view(id)).body.balances.principal).toBe(3_000);
    });

    it('does not lose credit when purchases and payments interleave', async () => {
      const { id } = await card();
      await authorize(id, 40_000);
      const ops = [
        ...Array.from({ length: 10 }, () => pay(id, 1_000)),
        ...Array.from({ length: 10 }, () => authorize(id, 1_000)),
      ];
      const results = await Promise.all(ops);
      const paid = results.slice(0, 10).filter((r) => r.status === 201).length;
      const approved = results
        .slice(10)
        .filter((r) => r.body.status === 'APPROVED').length;
      const account = await ctx.prisma.cardAccount.findUniqueOrThrow({
        where: { id },
      });
      expect(account.principal).toBe(
        BigInt(40_000 + approved * 1_000 - paid * 1_000),
      );
      expect(account.principal).toBeLessThanOrEqual(90_000n);
      await assertJournalMatchesBalances(id);
    });
  });

  describe('ownership', () => {
    it('hides accounts from other users', async () => {
      const { id } = await card();
      expect((await view(id, 'user-2')).status).toBe(404);
      expect((await view(id)).status).toBe(200);
      await http()
        .get(`/accounts/${id}/movements`)
        .set('Authorization', `Bearer ${await userToken('user-2')}`)
        .expect(404);
    });

    it('lists movements', async () => {
      const { id } = await card();
      await authorize(id, 1_000);
      await authorize(id, 2_000);
      const res = await http()
        .get(`/accounts/${id}/movements?limit=1`)
        .set('Authorization', `Bearer ${await userToken('user-1')}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ type: 'PURCHASE', amount: 2_000 });
    });
  });

  describe('database guarantees', () => {
    it('refuses to modify the journal or negative balances', async () => {
      const { id } = await card();
      await authorize(id, 1_000);
      await expect(
        ctx.prisma.$executeRawUnsafe('UPDATE movements SET amount = 1'),
      ).rejects.toThrow();
      await expect(
        ctx.prisma.$executeRawUnsafe('DELETE FROM movements'),
      ).rejects.toThrow();
      await expect(
        ctx.prisma.$executeRawUnsafe(
          `UPDATE card_accounts SET principal = -1 WHERE id = '${id}'::uuid`,
        ),
      ).rejects.toThrow();
    });
  });
});
