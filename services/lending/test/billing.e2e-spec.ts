import request from 'supertest';
import { SCOPES } from '@acme/contracts';
import { BillingJobsService } from '../src/modules/billing/billing-jobs.service.js';
import {
  createTestApp,
  resetDatabase,
  serviceToken,
  userToken,
  type TestContext,
} from './support/test-app.js';

describe('billing (e2e)', () => {
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
    await ctx.prisma.$executeRawUnsafe(
      'TRUNCATE billing_profiles, statements, statement_outcomes CASCADE',
    );
    await ctx.cache.delete(`limit:${CUSTODY_ID}`);
    ctx.clock.set(START);
    ctx.custody.accounts.clear();
    ctx.custody.settlements.length = 0;
    ctx.custody.down = false;
    ctx.custody.seed(CUSTODY_ID, 'user-1', 100_000);
  });

  async function card(cycleDay = 15) {
    const res = await http()
      .post('/cards')
      .set('Authorization', `Bearer ${await userToken('user-1')}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ custodyAccountId: CUSTODY_ID, cycleDay });
    expect(res.status).toBe(201);
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

  async function pay(accountId: string, amount: number) {
    return http()
      .post(`/accounts/${accountId}/payments`)
      .set('Authorization', `Bearer ${await userToken('user-1')}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ amount });
  }

  const goTo = (iso: string) => ctx.clock.set(new Date(iso));
  const statements = (accountId: string) =>
    ctx.prisma.statement.findMany({
      where: { accountId },
      orderBy: { cycleNumber: 'asc' },
    });

  async function assertStatementsReconcile(accountId: string) {
    for (const s of await statements(accountId)) {
      expect(s.closingBalance).toBe(
        s.openingBalance +
          s.purchases +
          s.interestCharged +
          s.feesCharged -
          s.reversals -
          s.payments,
      );
    }
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
          (t, m) => t + (m.direction === 'DEBIT' ? m.amount : -m.amount),
          0n,
        );
    expect([account.principal, account.interest, account.fees]).toEqual([
      sum('PRINCIPAL'),
      sum('INTEREST'),
      sum('FEES'),
    ]);
  }

  describe('statements and interest', () => {
    it('cuts on the chosen day and charges interest on the average daily balance', async () => {
      const { id } = await card(15);
      await authorize(id, 90_000);
      goTo('2026-01-14T23:00:00Z');
      expect(await jobs().runDaily()).toMatchObject({ statementsIssued: 0 });
      goTo('2026-01-15T12:00:00Z');
      expect(await jobs().runDaily()).toMatchObject({ statementsIssued: 1 });

      const [s] = await statements(id);
      expect(s).toMatchObject({
        cycleNumber: 1,
        openingBalance: 0n,
        purchases: 90_000n,
        interestCharged: 444n,
        closingBalance: 90_444n,
        minimumPayment: 4_522n,
        termsVersion: 1,
      });
      expect(s.periodStart.toISOString().slice(0, 10)).toBe('2026-01-10');
      expect(s.periodEnd.toISOString().slice(0, 10)).toBe('2026-01-15');
      expect(s.dueDate.toISOString().slice(0, 10)).toBe('2026-02-04');
      expect(s.termsSnapshot).toMatchObject({ aprBps: 3600, dueDays: 20 });
      const account = await ctx.prisma.cardAccount.findUniqueOrThrow({
        where: { id },
      });
      expect([account.principal, account.interest]).toEqual([90_000n, 444n]);
      await assertStatementsReconcile(id);
    });

    it('uses the balance of each day, so an early payment lowers the interest', async () => {
      const { id } = await card(15);
      await authorize(id, 90_000);
      goTo('2026-01-12T09:00:00Z');
      await pay(id, 40_000);
      goTo('2026-01-15T12:00:00Z');
      await jobs().runDaily();
      const [s] = await statements(id);
      expect(s.interestCharged).toBe(325n);
      expect(s.payments).toBe(40_000n);
      expect(s.closingBalance).toBe(90_000n - 40_000n + 325n);
      await assertStatementsReconcile(id);
    });

    it('starts the next period from the previous closing balance', async () => {
      const { id } = await card(15);
      await authorize(id, 50_000);
      goTo('2026-01-15T12:00:00Z');
      await jobs().runDaily();
      await authorize(id, 10_000);
      goTo('2026-02-15T12:00:00Z');
      await jobs().runDaily();
      const [first, second] = await statements(id);
      expect(second.openingBalance).toBe(first.closingBalance);
      expect(second.purchases).toBe(10_000n);
      expect(second.periodStart.toISOString().slice(0, 10)).toBe('2026-01-15');
      await assertStatementsReconcile(id);
    });

    it('does not charge interest on interest or fees', async () => {
      const { id } = await card(15);
      await authorize(id, 10_000);
      goTo('2026-01-15T12:00:00Z');
      await jobs().runDaily();
      const owed = await ctx.prisma.cardAccount.findUniqueOrThrow({
        where: { id },
      });
      expect(
        (await pay(id, Number(owed.principal + owed.interest))).status,
      ).toBe(201);
      goTo('2026-02-15T12:00:00Z');
      await jobs().runDaily();
      const second = (await statements(id))[1];
      expect(second.interestCharged).toBe(0n);
      await assertStatementsReconcile(id);
    });

    it('issues every missed cycle in order when the job was not run', async () => {
      const { id } = await card(1);
      await authorize(id, 20_000);
      goTo('2026-04-02T12:00:00Z');
      const result = await jobs().runDaily();
      expect(result.statementsIssued).toBe(3);
      const all = await statements(id);
      expect(all.map((s) => s.cycleNumber)).toEqual([1, 2, 3]);
      expect(all.map((s) => s.periodEnd.toISOString().slice(0, 10))).toEqual([
        '2026-02-01',
        '2026-03-01',
        '2026-04-01',
      ]);
      await assertStatementsReconcile(id);
    });

    it('is idempotent and safe to run concurrently', async () => {
      const { id } = await card(15);
      await authorize(id, 30_000);
      goTo('2026-01-15T12:00:00Z');
      await Promise.all([
        jobs().runDaily(),
        jobs().runDaily(),
        jobs().runDaily(),
      ]);
      await jobs().runDaily();
      expect(await statements(id)).toHaveLength(1);
      expect(
        await ctx.prisma.movement.count({ where: { type: 'INTEREST' } }),
      ).toBe(1);
      await assertStatementsReconcile(id);
    });

    it('does not issue statements for closing or closed accounts', async () => {
      const { id } = await card(15);
      await ctx.prisma.cardAccount.update({
        where: { id },
        data: { status: 'CLOSED' },
      });
      goTo('2026-02-20T12:00:00Z');
      await jobs().runDaily();
      expect(await statements(id)).toHaveLength(0);
    });

    it('exposes statements only to the owner', async () => {
      const { id } = await card(15);
      await authorize(id, 10_000);
      goTo('2026-01-15T12:00:00Z');
      await jobs().runDaily();
      const mine = await http()
        .get(`/accounts/${id}/statements`)
        .set('Authorization', `Bearer ${await userToken('user-1')}`);
      expect(mine.status).toBe(200);
      expect(mine.body[0]).toMatchObject({
        cycleNumber: 1,
        periodEnd: '2026-01-15',
        dueDate: '2026-02-04',
      });
      await http()
        .get(`/accounts/${id}/statements/1`)
        .set('Authorization', `Bearer ${await userToken('user-1')}`)
        .expect(200);
      await http()
        .get(`/accounts/${id}/statements/9`)
        .set('Authorization', `Bearer ${await userToken('user-1')}`)
        .expect(404);
      await http()
        .get(`/accounts/${id}/statements`)
        .set('Authorization', `Bearer ${await userToken('user-2')}`)
        .expect(404);
    });

    it('refuses to modify a statement', async () => {
      const { id } = await card(15);
      await authorize(id, 10_000);
      goTo('2026-01-15T12:00:00Z');
      await jobs().runDaily();
      await expect(
        ctx.prisma.$executeRawUnsafe(
          'UPDATE statements SET minimum_payment = 0',
        ),
      ).rejects.toThrow();
    });
  });

  describe('late payments', () => {
    async function withStatement() {
      const { id } = await card(15);
      await authorize(id, 90_000);
      goTo('2026-01-15T12:00:00Z');
      await jobs().runDaily();
      return id;
    }

    it('charges a single late fee and blocks purchases when the minimum is not paid', async () => {
      const id = await withStatement();
      goTo('2026-02-04T20:00:00Z');
      expect((await jobs().runDaily()).statementsLate).toBe(0);
      goTo('2026-02-05T09:00:00Z');
      expect((await jobs().runDaily()).statementsLate).toBe(1);
      await jobs().runDaily();

      const account = await ctx.prisma.cardAccount.findUniqueOrThrow({
        where: { id },
      });
      expect(account.status).toBe('DELINQUENT');
      expect(account.fees).toBe(1_500n);
      expect(
        await ctx.prisma.movement.count({ where: { type: 'LATE_FEE' } }),
      ).toBe(1);
      const profile = await ctx.prisma.billingProfile.findUniqueOrThrow({
        where: { accountId: id },
      });
      expect(profile.delinquentSince?.toISOString().slice(0, 10)).toBe(
        '2026-02-04',
      );
      expect((await authorize(id, 100)).body).toMatchObject({
        status: 'DECLINED',
        reason: 'ACCOUNT_NOT_ACTIVE',
      });
      await assertStatementsReconcile(id);
    });

    it('does not charge a fee when the minimum is paid by the due date', async () => {
      const id = await withStatement();
      goTo('2026-02-04T18:00:00Z');
      await pay(id, 4_522);
      goTo('2026-02-05T09:00:00Z');
      expect((await jobs().runDaily()).statementsLate).toBe(0);
      const account = await ctx.prisma.cardAccount.findUniqueOrThrow({
        where: { id },
      });
      expect([account.status, account.fees]).toEqual(['ACTIVE', 0n]);
      const outcome = await ctx.prisma.statementOutcome.findFirstOrThrow();
      expect(outcome.outcome).toBe('PAID');
    });

    it('does not count payments made before the cut towards the minimum', async () => {
      const { id } = await card(15);
      await authorize(id, 90_000);
      goTo('2026-01-12T12:00:00Z');
      await pay(id, 50_000);
      goTo('2026-01-15T12:00:00Z');
      await jobs().runDaily();
      goTo('2026-02-05T09:00:00Z');
      expect((await jobs().runDaily()).statementsLate).toBe(1);
    });

    it('returns to active as soon as the minimum is paid', async () => {
      const id = await withStatement();
      goTo('2026-02-05T09:00:00Z');
      await jobs().runDaily();
      expect(
        (await ctx.prisma.cardAccount.findUniqueOrThrow({ where: { id } }))
          .status,
      ).toBe('DELINQUENT');
      expect((await pay(id, 3_000)).status).toBe(201);
      expect(
        (await ctx.prisma.cardAccount.findUniqueOrThrow({ where: { id } }))
          .status,
      ).toBe('DELINQUENT');
      expect((await pay(id, 1_522)).status).toBe(201);
      const account = await ctx.prisma.cardAccount.findUniqueOrThrow({
        where: { id },
      });
      expect(account.status).toBe('ACTIVE');
      const profile = await ctx.prisma.billingProfile.findUniqueOrThrow({
        where: { accountId: id },
      });
      expect(profile.delinquentSince).toBeNull();
      expect((await authorize(id, 100)).body.status).toBe('APPROVED');
    });

    it('closes the account and applies the collateral after the charge-off period', async () => {
      const id = await withStatement();
      let closedOn: string | undefined;
      for (let day = 0; day < 130; day++) {
        goTo(new Date(Date.UTC(2026, 1, 5 + day, 9)).toISOString());
        const result = await jobs().runDaily();
        if (result.accountsChargedOff > 0) {
          closedOn = ctx.clock.now().toISOString().slice(0, 10);
          break;
        }
      }
      expect(closedOn).toBe('2026-05-05');
      const account = await ctx.prisma.cardAccount.findUniqueOrThrow({
        where: { id },
      });
      expect(account.status).toBe('CLOSED');
      expect(account.closureReason).toBe('CHARGE_OFF');
      expect(ctx.custody.settlements).toHaveLength(1);
      expect(ctx.custody.settlements[0].applyAmount).toBe(
        Number(account.closureDebt),
      );
      const collateral = 100_000n;
      const debt = account.closureDebt as bigint;
      expect(account.principal + account.interest + account.fees).toBe(
        debt > collateral ? debt - collateral : 0n,
      );
      await assertStatementsReconcile(id);
    });
  });

  describe('jobs endpoint', () => {
    it('requires a service token with the jobs scope', async () => {
      await http().post('/internal/jobs/daily').expect(401);
      await http()
        .post('/internal/jobs/daily')
        .set('Authorization', `Bearer ${await userToken('user-1')}`)
        .expect(403);
      await http()
        .post('/internal/jobs/daily')
        .set('Authorization', `Bearer ${await serviceToken([])}`)
        .expect(403);
      const ok = await http()
        .post('/internal/jobs/daily')
        .set(
          'Authorization',
          `Bearer ${await serviceToken([SCOPES.jobsRun], 'scheduler')}`,
        );
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ statementsIssued: 0 });
    });
  });
});
