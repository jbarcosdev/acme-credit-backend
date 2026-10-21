import request from 'supertest';
import { SCOPES } from '@acme/contracts';
import { BillingJobsService } from '../src/modules/billing/billing-jobs.service.js';
import { buildSchedule } from '../src/modules/billing/installments.js';
import { interestFor } from '../src/modules/billing/rounding.js';
import {
  createTestApp,
  resetDatabase,
  serviceToken,
  userToken,
  type TestContext,
} from './support/test-app.js';

describe('deferred purchases (e2e)', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());
  const CUSTODY_ID = '11111111-1111-4111-8111-111111111111';
  const START = new Date('2026-01-10T12:00:00Z');
  const jobs = () => ctx.app.get(BillingJobsService);

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await ctx.cache.delete(`limit:${CUSTODY_ID}`);
    ctx.clock.set(START);
    ctx.custody.accounts.clear();
    ctx.custody.settlements.length = 0;
    ctx.custody.down = false;
    ctx.custody.seed(CUSTODY_ID, 'user-1', 100_000);
  });

  async function card() {
    const res = await http()
      .post('/cards')
      .set('Authorization', `Bearer ${await userToken('user-1')}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ custodyAccountId: CUSTODY_ID, cycleDay: 15 });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function authorize(
    accountId: string,
    body: { amount: number; installments?: number },
  ) {
    return http()
      .post(`/accounts/${accountId}/authorizations`)
      .set(
        'Authorization',
        `Bearer ${await serviceToken([SCOPES.authorizationsWrite])}`,
      )
      .set('Idempotency-Key', crypto.randomUUID())
      .send(body);
  }

  async function reverse(accountId: string, authorizationId: string) {
    return http()
      .post(
        `/accounts/${accountId}/authorizations/${authorizationId}/reversals`,
      )
      .set(
        'Authorization',
        `Bearer ${await serviceToken([SCOPES.authorizationsWrite])}`,
      )
      .set('Idempotency-Key', crypto.randomUUID())
      .send();
  }

  async function pay(accountId: string, amount: number) {
    return http()
      .post(`/accounts/${accountId}/payments`)
      .set('Authorization', `Bearer ${await userToken('user-1')}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ amount });
  }

  const goTo = (iso: string) => ctx.clock.set(new Date(iso));
  const account = (id: string) =>
    ctx.prisma.cardAccount.findUniqueOrThrow({ where: { id } });
  const statements = (id: string) =>
    ctx.prisma.statement.findMany({
      where: { accountId: id },
      orderBy: { cycleNumber: 'asc' },
    });
  const plans = (id: string) =>
    ctx.prisma.installmentPlan.findMany({
      where: { accountId: id },
      orderBy: { createdAt: 'asc' },
    });

  async function assertReconciled(accountId: string) {
    for (const s of await statements(accountId)) {
      expect(s.closingBalance).toBe(
        s.openingBalance +
          s.purchases +
          s.interestCharged +
          s.feesCharged +
          s.installmentPrincipal +
          s.installmentInterest -
          s.reversals -
          s.payments,
      );
    }
    const a = await account(accountId);
    const movements = await ctx.prisma.movement.findMany({
      where: { accountId },
    });
    const sum = (bucket: string) =>
      movements
        .filter((m) => m.bucket === bucket)
        .reduce(
          (t, m) => t + (m.direction === 'DEBIT' ? m.amount : -m.amount),
          0n,
        );
    expect([a.principal, a.deferred, a.interest, a.fees]).toEqual([
      sum('PRINCIPAL'),
      sum('DEFERRED'),
      sum('INTEREST'),
      sum('FEES'),
    ]);
  }

  describe('purchases', () => {
    it('only offers the configured installment plans and amounts', async () => {
      const id = await card();
      const unavailable = await authorize(id, {
        amount: 10_000,
        installments: 4,
      });
      expect(unavailable.status).toBe(422);
      expect(unavailable.body.code).toBe('INSTALLMENTS_NOT_AVAILABLE');
      const small = await authorize(id, { amount: 4_999, installments: 3 });
      expect(small.status).toBe(422);
      expect(small.body.code).toBe('AMOUNT_BELOW_INSTALLMENT_MINIMUM');
      expect(
        (await authorize(id, { amount: 10_000, installments: 1 })).status,
      ).toBe(400);
      expect(await ctx.prisma.movement.count()).toBe(0);
    });

    it('counts the whole purchase against the credit from day one but keeps it out of the payable debt', async () => {
      const id = await card();
      const res = await authorize(id, { amount: 12_000, installments: 3 });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'APPROVED',
        availableCredit: 78_000,
        installments: 3,
        installmentAprBps: 0,
      });
      const a = await account(id);
      expect([a.principal, a.deferred]).toEqual([0n, 12_000n]);
      const paid = await pay(id, 1);
      expect(paid.status).toBe(422);
      expect(paid.body.code).toBe('PAYMENT_EXCEEDS_DEBT');
      const movement = await ctx.prisma.movement.findFirstOrThrow({
        where: { type: 'PURCHASE' },
      });
      expect([
        movement.bucket,
        movement.installments,
        movement.rateBps,
      ]).toEqual(['DEFERRED', 3, 0]);
    });

    it('shares the credit limit with regular purchases under concurrency', async () => {
      const id = await card();
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          authorize(
            id,
            i % 2 === 0
              ? { amount: 5_000, installments: 3 }
              : { amount: 5_000 },
          ),
        ),
      );
      expect(results.filter((r) => r.body.status === 'APPROVED')).toHaveLength(
        18,
      );
      const a = await account(id);
      expect(a.principal + a.deferred).toBe(90_000n);
      await assertReconciled(id);
    });
  });

  describe('billing', () => {
    it('bills one installment per cut, charges revolving interest only on what was billed and left unpaid, and completes the plan', async () => {
      const id = await card();
      await authorize(id, { amount: 12_000, installments: 3 });

      goTo('2026-01-15T12:00:00Z');
      expect(await jobs().runDaily()).toMatchObject({ statementsIssued: 1 });
      let [first] = await statements(id);
      expect(first).toMatchObject({
        purchases: 0n,
        deferredPurchases: 12_000n,
        deferredBalance: 8_000n,
        installmentPrincipal: 4_000n,
        installmentInterest: 0n,
        interestCharged: 0n,
        closingBalance: 4_000n,
        minimumPayment: 4_000n,
      });
      expect(first.installmentDetails).toEqual([
        expect.objectContaining({
          number: 1,
          of: 3,
          principal: '4000',
          interest: '0',
          amount: '4000',
        }),
      ]);
      expect(await account(id)).toMatchObject({
        principal: 4_000n,
        deferred: 8_000n,
      });
      expect((await plans(id))[0]).toMatchObject({
        billedCount: 1,
        remainingPrincipal: 8_000n,
        status: 'ACTIVE',
      });

      goTo('2026-02-15T12:00:00Z');
      await jobs().runDaily();
      const second = (await statements(id))[1];
      const revolving = interestFor(4_000n * 31n, 3600);
      expect(second).toMatchObject({
        openingBalance: 4_000n,
        interestCharged: revolving,
        installmentPrincipal: 4_000n,
        deferredBalance: 4_000n,
      });
      expect(second.closingBalance).toBe(4_000n + revolving + 4_000n);

      goTo('2026-03-15T12:00:00Z');
      await jobs().runDaily();
      const third = (await statements(id))[2];
      expect(third).toMatchObject({
        installmentPrincipal: 4_000n,
        deferredBalance: 0n,
      });
      expect((await plans(id))[0]).toMatchObject({
        billedCount: 3,
        remainingPrincipal: 0n,
        status: 'COMPLETED',
      });
      expect((await account(id)).deferred).toBe(0n);

      goTo('2026-04-15T12:00:00Z');
      await jobs().runDaily();
      expect((await statements(id))[3].installmentPrincipal).toBe(0n);
      await assertReconciled(id);
    });

    it('follows the annuity schedule of an interest-bearing plan', async () => {
      const id = await card();
      await authorize(id, { amount: 60_000, installments: 6 });
      const schedule = buildSchedule(60_000n, 6, 1800);

      for (let month = 0; month < 6; month++) {
        goTo(new Date(Date.UTC(2026, 0 + month, 15, 12)).toISOString());
        await jobs().runDaily();
        const statement = (await statements(id))[month];
        expect(statement.installmentPrincipal).toBe(schedule[month].principal);
        expect(statement.installmentInterest).toBe(schedule[month].interest);
        expect(statement.interestCharged).toBe(0n);
        const owed = await account(id);
        expect(
          (await pay(id, Number(owed.principal + owed.interest + owed.fees)))
            .status,
        ).toBe(201);
      }
      const finished = await account(id);
      expect([
        finished.principal,
        finished.deferred,
        finished.interest,
        finished.fees,
      ]).toEqual([0n, 0n, 0n, 0n]);
      expect((await plans(id))[0].status).toBe('COMPLETED');
      const totalInterest = (await statements(id)).reduce(
        (t, s) => t + s.installmentInterest,
        0n,
      );
      expect(totalInterest).toBe(schedule.reduce((t, b) => t + b.interest, 0n));
      await assertReconciled(id);
    });

    it('includes the installment in the minimum payment and charges the late fee when it is not paid', async () => {
      const id = await card();
      await authorize(id, { amount: 60_000, installments: 3 });
      goTo('2026-01-15T12:00:00Z');
      await jobs().runDaily();
      const [statement] = await statements(id);
      expect(statement.minimumPayment).toBeGreaterThanOrEqual(
        statement.installmentPrincipal + statement.installmentInterest,
      );
      goTo('2026-02-04T12:00:00Z');
      await pay(id, Number(statement.minimumPayment) - 1);
      goTo('2026-02-05T12:00:00Z');
      expect((await jobs().runDaily()).statementsLate).toBe(1);
      expect((await account(id)).status).toBe('DELINQUENT');
    });

    it('runs several plans in the same cycle and starts plans created after the cut in the next one', async () => {
      const id = await card();
      await authorize(id, { amount: 6_000, installments: 3 });
      await authorize(id, { amount: 12_000, installments: 6 });
      goTo('2026-01-15T12:00:00Z');
      await jobs().runDaily();
      const [first] = await statements(id);
      expect(first.installmentDetails as unknown[]).toHaveLength(2);
      expect(first.deferredPurchases).toBe(18_000n);
      const late = await authorize(id, { amount: 9_000, installments: 3 });
      expect(late.body.status).toBe('APPROVED');
      goTo('2026-02-15T12:00:00Z');
      await jobs().runDaily();
      expect(
        (await statements(id))[1].installmentDetails as unknown[],
      ).toHaveLength(3);
      expect(await plans(id)).toHaveLength(3);
      await assertReconciled(id);
    });

    it('is safe to run concurrently', async () => {
      const id = await card();
      await authorize(id, { amount: 12_000, installments: 3 });
      goTo('2026-01-15T12:00:00Z');
      await Promise.all([
        jobs().runDaily(),
        jobs().runDaily(),
        jobs().runDaily(),
      ]);
      expect(await statements(id)).toHaveLength(1);
      expect((await plans(id))[0].billedCount).toBe(1);
      expect(
        await ctx.prisma.movement.count({
          where: { type: 'INSTALLMENT_PRINCIPAL' },
        }),
      ).toBe(2);
      await assertReconciled(id);
    });
  });

  describe('reversals', () => {
    it('can reverse a deferred purchase before it starts billing, and not afterwards', async () => {
      const id = await card();
      const first = (await authorize(id, { amount: 12_000, installments: 3 }))
        .body.authorizationId;
      const second = (await authorize(id, { amount: 6_000, installments: 3 }))
        .body.authorizationId;
      expect((await reverse(id, first)).status).toBe(201);
      expect((await account(id)).deferred).toBe(6_000n);

      goTo('2026-01-15T12:00:00Z');
      await jobs().runDaily();
      const [statement] = await statements(id);
      expect(statement.deferredPurchases).toBe(6_000n);
      expect(await plans(id)).toHaveLength(1);
      const billed = await reverse(id, second);
      expect(billed.status).toBe(422);
      expect(billed.body.code).toBe('DEFERRED_PURCHASE_ALREADY_BILLED');
      await assertReconciled(id);
    });
  });

  describe('closure', () => {
    it('accelerates the plan: the collateral covers the billed debt and the deferred balance', async () => {
      const id = await card();
      await authorize(id, { amount: 12_000, installments: 3 });
      goTo('2026-01-15T12:00:00Z');
      await jobs().runDaily();

      const res = await http()
        .post(`/accounts/${id}/closure`)
        .set('Authorization', `Bearer ${await userToken('user-1')}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send();
      expect(res.body).toEqual({ status: 'CLOSED', debt: 0 });
      expect(ctx.custody.settlements[0].applyAmount).toBe(12_000);
      const closed = await account(id);
      expect([closed.principal, closed.deferred, closed.status]).toEqual([
        0n,
        0n,
        'CLOSED',
      ]);
      expect((await plans(id))[0].status).toBe('ACCELERATED');
      const applications = await ctx.prisma.movement.findMany({
        where: { type: 'COLLATERAL_APPLICATION' },
        orderBy: { createdAt: 'asc' },
      });
      expect(applications.map((m) => [m.bucket, m.amount])).toEqual([
        ['PRINCIPAL', 4_000n],
        ['DEFERRED', 8_000n],
      ]);
    });
  });

  describe('plans endpoint', () => {
    it('shows the plans to the owner only', async () => {
      const id = await card();
      await authorize(id, { amount: 12_000, installments: 3 });
      goTo('2026-01-15T12:00:00Z');
      await jobs().runDaily();
      const mine = await http()
        .get(`/accounts/${id}/installment-plans`)
        .set('Authorization', `Bearer ${await userToken('user-1')}`);
      expect(mine.status).toBe(200);
      expect(mine.body).toEqual([
        expect.objectContaining({
          principal: 12_000,
          installments: 3,
          aprBps: 0,
          installmentAmount: 4_000,
          billed: 1,
          remainingPrincipal: 8_000,
          status: 'ACTIVE',
        }),
      ]);
      await http()
        .get(`/accounts/${id}/installment-plans`)
        .set('Authorization', `Bearer ${await userToken('user-2')}`)
        .expect(404);
    });
  });

  describe('database guarantees', () => {
    it('refuses inconsistent plans and installment metadata on other movements', async () => {
      const id = await card();
      await authorize(id, { amount: 12_000, installments: 3 });
      goTo('2026-01-15T12:00:00Z');
      await jobs().runDaily();
      await expect(
        ctx.prisma.$executeRawUnsafe(
          'UPDATE installment_plans SET billed_count = 9',
        ),
      ).rejects.toThrow();
      await expect(
        ctx.prisma.$executeRawUnsafe(
          'UPDATE installment_plans SET remaining_principal = principal + 1',
        ),
      ).rejects.toThrow();
    });
  });
});
