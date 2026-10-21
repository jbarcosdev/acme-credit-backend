import request from 'supertest';
import { SCOPES } from '@acme/contracts';
import { ClosureService } from '../src/modules/accounts/closure.service.js';
import { LimitReductionService } from '../src/modules/accounts/limit-reduction.service.js';
import {
  createTestApp,
  resetDatabase,
  serviceToken,
  userToken,
  type TestContext,
} from './support/test-app.js';

describe('closure and limit reduction (e2e)', () => {
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
    await ctx.cache.delete(`limit:${CUSTODY_ID}`);
    ctx.custody.accounts.clear();
    ctx.custody.settlements.length = 0;
    ctx.custody.reductions.length = 0;
    ctx.custody.down = false;
    ctx.custody.seed(CUSTODY_ID, 'user-1', 100_000);
  });

  async function card() {
    const res = await http()
      .post('/cards')
      .set('Authorization', `Bearer ${await userToken('user-1')}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ custodyAccountId: CUSTODY_ID, cycleDay: 1 });
    return res.body as { id: string };
  }

  async function authorize(accountId: string, amount: number) {
    return http()
      .post(`/accounts/${accountId}/authorizations`)
      .set(
        'Authorization',
        `Bearer ${await serviceToken([SCOPES.authorizationsWrite])}`,
      )
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ amount });
  }

  async function close(
    accountId: string,
    owner = 'user-1',
    key = crypto.randomUUID(),
  ) {
    return http()
      .post(`/accounts/${accountId}/closure`)
      .set('Authorization', `Bearer ${await userToken(owner)}`)
      .set('Idempotency-Key', key)
      .send();
  }

  async function reduce(
    accountId: string,
    newCupo: number,
    key = crypto.randomUUID(),
  ) {
    return http()
      .post(`/accounts/${accountId}/limit-reduction`)
      .set('Authorization', `Bearer ${await userToken('user-1')}`)
      .set('Idempotency-Key', key)
      .send({ newCupo });
  }

  describe('closure', () => {
    it('releases the whole collateral when there is no debt', async () => {
      const { id } = await card();
      const res = await close(id);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'CLOSED', debt: 0 });
      expect(ctx.custody.settlements).toEqual([
        { id: CUSTODY_ID, key: `close:${id}`, applyAmount: 0 },
      ]);
    });

    it('applies the collateral to the outstanding debt', async () => {
      const { id } = await card();
      await authorize(id, 30_000);
      await ctx.prisma.cardAccount.update({
        where: { id },
        data: { interest: 2_000n, fees: 1_500n },
      });
      const res = await close(id);
      expect(res.body).toEqual({ status: 'CLOSED', debt: 0 });
      expect(ctx.custody.settlements[0].applyAmount).toBe(33_500);
      const account = await ctx.prisma.cardAccount.findUniqueOrThrow({
        where: { id },
      });
      expect([
        account.principal,
        account.interest,
        account.fees,
        account.status,
      ]).toEqual([0n, 0n, 0n, 'CLOSED']);
      const applications = await ctx.prisma.movement.findMany({
        where: { type: 'COLLATERAL_APPLICATION' },
        orderBy: { createdAt: 'asc' },
      });
      expect(applications.map((m) => [m.bucket, m.amount])).toEqual([
        ['FEES', 1_500n],
        ['INTEREST', 2_000n],
        ['PRINCIPAL', 30_000n],
      ]);
      expect(account.closedAt).not.toBeNull();
    });

    it('records the shortfall when the collateral does not cover the debt', async () => {
      const { id } = await card();
      await ctx.prisma.cardAccount.update({
        where: { id },
        data: { principal: 120_000n },
      });
      const res = await close(id);
      expect(res.body).toEqual({
        status: 'CLOSED',
        debt: 0,
        shortfall: 20_000,
      });
      const account = await ctx.prisma.cardAccount.findUniqueOrThrow({
        where: { id },
      });
      expect(account.principal).toBe(20_000n);
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'account.closed' },
      });
      expect((audit.data as { shortfall: string }).shortfall).toBe('20000');
    });

    it('stays closing while custody is down and completes on retry with the same key', async () => {
      const { id } = await card();
      await authorize(id, 10_000);
      ctx.custody.down = true;
      const res = await close(id);
      expect(res.status).toBe(202);
      expect(res.body.status).toBe('CLOSING');

      expect((await authorize(id, 100)).body).toMatchObject({
        status: 'DECLINED',
        reason: 'ACCOUNT_NOT_ACTIVE',
      });
      const payment = await http()
        .post(`/accounts/${id}/payments`)
        .set('Authorization', `Bearer ${await userToken('user-1')}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ amount: 100 });
      expect(payment.status).toBe(409);

      ctx.custody.down = false;
      expect(await ctx.app.get(ClosureService).retryPending()).toBe(1);
      expect(
        (await ctx.prisma.cardAccount.findUniqueOrThrow({ where: { id } }))
          .status,
      ).toBe('CLOSED');
      expect(ctx.custody.settlements.map((s) => s.key)).toEqual([
        `close:${id}`,
      ]);
      expect(await ctx.app.get(ClosureService).retryPending()).toBe(0);
    });

    it('is idempotent, owner-only and cannot be repeated', async () => {
      const { id } = await card();
      expect((await close(id, 'user-2')).status).toBe(404);
      const key = crypto.randomUUID();
      const first = await close(id, 'user-1', key);
      const replay = await close(id, 'user-1', key);
      expect(replay.body).toEqual(first.body);
      expect((await close(id)).status).toBe(409);
      expect(ctx.custody.settlements).toHaveLength(1);
    });

    it('does not settle twice when closure is requested concurrently', async () => {
      const { id } = await card();
      await Promise.all(Array.from({ length: 5 }, () => close(id)));
      expect(ctx.custody.settlements.length).toBeLessThanOrEqual(5);
      expect(new Set(ctx.custody.settlements.map((s) => s.key)).size).toBe(1);
      expect(
        (await ctx.prisma.cardAccount.findUniqueOrThrow({ where: { id } }))
          .status,
      ).toBe('CLOSED');
      expect(
        await ctx.prisma.movement.count({
          where: { type: 'COLLATERAL_APPLICATION' },
        }),
      ).toBe(0);
    });
  });

  describe('limit reduction', () => {
    it('lowers the limit, releases collateral and clears the cap', async () => {
      const { id } = await card();
      await authorize(id, 30_000);
      const res = await reduce(id, 45_000);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'APPLIED', newCupo: 45_000 });
      expect(ctx.custody.reductions).toHaveLength(1);
      const account = await ctx.prisma.cardAccount.findUniqueOrThrow({
        where: { id },
      });
      expect(account.limitCap).toBeNull();
      const view = await http()
        .get(`/accounts/${id}`)
        .set('Authorization', `Bearer ${await userToken('user-1')}`);
      expect(view.body.limit.cupo).toBe(45_000);
      expect(view.body.availableCredit).toBe(15_000);
      expect((await authorize(id, 15_001)).body.status).toBe('DECLINED');
    });

    it('rejects a limit lower than the debt and leaves nothing behind', async () => {
      const { id } = await card();
      await authorize(id, 30_000);
      const res = await reduce(id, 29_999);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('DEBT_EXCEEDS_NEW_LIMIT');
      expect(
        (await ctx.prisma.cardAccount.findUniqueOrThrow({ where: { id } }))
          .limitCap,
      ).toBeNull();
      expect(ctx.custody.reductions).toHaveLength(0);
    });

    it('keeps the cap enforced while custody is down and finishes on retry', async () => {
      const { id } = await card();
      ctx.custody.down = true;
      const res = await reduce(id, 20_000);
      expect(res.status).toBe(202);
      expect(res.body.status).toBe('PENDING');
      expect((await authorize(id, 20_001)).body.status).toBe('DECLINED');
      expect((await reduce(id, 10_000)).status).toBe(409);

      ctx.custody.down = false;
      expect(await ctx.app.get(LimitReductionService).retryPending()).toBe(1);
      expect(
        (await ctx.prisma.cardAccount.findUniqueOrThrow({ where: { id } }))
          .limitCap,
      ).toBeNull();
      expect(ctx.custody.reductions).toHaveLength(1);
      expect((await authorize(id, 20_001)).body.status).toBe('DECLINED');
    });

    it('never lets the debt exceed the reduced limit while it is in flight', async () => {
      const { id } = await card();
      const [reduction, ...purchases] = await Promise.all([
        reduce(id, 50_000),
        ...Array.from({ length: 80 }, () => authorize(id, 1_000)),
      ]);
      const account = await ctx.prisma.cardAccount.findUniqueOrThrow({
        where: { id },
      });
      const approved = purchases.filter(
        (p) => p.body.status === 'APPROVED',
      ).length;
      expect(account.principal).toBe(BigInt(approved * 1_000));
      if (reduction.status === 200) {
        expect(account.principal).toBeLessThanOrEqual(50_000n);
      } else {
        expect(reduction.status).toBe(422);
      }
    });
  });
});
