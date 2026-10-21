import request from 'supertest';
import { SCOPES } from '@acme/contracts';

process.env.DEV_CLOCK = 'true';
const { createTestApp, resetDatabase, serviceToken, userToken } =
  await import('./support/test-app.js');

describe('development clock (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const http = () => request(ctx.app.getHttpServer());
  const CUSTODY_ID = '11111111-1111-4111-8111-111111111111';

  beforeAll(async () => {
    ctx = await createTestApp({}, { keepClock: true });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ctx.custody.accounts.clear();
    await ctx.cache.delete(`limit:${CUSTODY_ID}`);
    ctx.custody.seed(CUSTODY_ID, 'user-1', 100_000);
  });

  const admin = async () => ({
    Authorization: `Bearer ${await serviceToken([SCOPES.jobsRun], 'scheduler')}`,
  });

  it('moves forward only and is restricted to the jobs scope', async () => {
    const before = (
      await http()
        .get('/internal/dev/clock')
        .set(await admin())
    ).body.now as string;
    const advanced = await http()
      .post('/internal/dev/clock')
      .set(await admin())
      .send({ days: 2 });
    expect(advanced.status).toBe(201);
    const delta =
      new Date(advanced.body.now).getTime() - new Date(before).getTime();
    expect(delta).toBeGreaterThan(2 * 86_400_000 - 5_000);
    expect(delta).toBeLessThan(2 * 86_400_000 + 5_000);

    expect(
      (
        await http()
          .post('/internal/dev/clock')
          .set(await admin())
          .send({ days: -1 })
      ).status,
    ).toBe(400);
    expect(
      (
        await http()
          .post('/internal/dev/clock')
          .set(await admin())
          .send({ to: '2020-01-01T00:00:00Z' })
      ).status,
    ).toBe(400);
    expect(
      (
        await http()
          .post('/internal/dev/clock')
          .set(await admin())
          .send({})
      ).status,
    ).toBe(400);
    await http()
      .get('/internal/dev/clock')
      .set('Authorization', `Bearer ${await userToken('user-1')}`)
      .expect(403);
    await http().get('/internal/dev/clock').expect(401);
  });

  it('lets the billing jobs see a statement after the clock passes the cut-off', async () => {
    const card = await http()
      .post('/cards')
      .set('Authorization', `Bearer ${await userToken('user-1')}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ custodyAccountId: CUSTODY_ID, cycleDay: 15 });
    await http()
      .post(`/accounts/${card.body.id}/authorizations`)
      .set(
        'Authorization',
        `Bearer ${await serviceToken([SCOPES.authorizationsWrite])}`,
      )
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ amount: 10_000 });

    const first = await http()
      .post('/internal/jobs/daily')
      .set(await admin());
    expect(first.body.statementsIssued).toBe(0);
    await http()
      .post('/internal/dev/clock')
      .set(await admin())
      .send({ days: 35 });
    const second = await http()
      .post('/internal/jobs/daily')
      .set(await admin());
    expect(second.body.statementsIssued).toBeGreaterThanOrEqual(1);
    const statements = await http()
      .get(`/accounts/${card.body.id}/statements`)
      .set('Authorization', `Bearer ${await userToken('user-1')}`);
    expect(statements.body[0].closingBalance).toBeGreaterThan(10_000);
  });
});
