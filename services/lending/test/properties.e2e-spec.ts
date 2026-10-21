import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import request from 'supertest';
import { SCOPES } from '@acme/contracts';
import {
  createTestApp,
  resetDatabase,
  serviceToken,
  userToken,
  type TestContext,
} from './support/test-app.js';

type Op =
  | { kind: 'purchase'; amount: number }
  | { kind: 'deferred'; amount: number }
  | { kind: 'payment'; amount: number }
  | { kind: 'reverse'; index: number };

const CUPO = 90_000;

describe('ledger properties (e2e)', () => {
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

  it('keeps the debt within the limit and the journal equal to the balances for any sequence of operations', async () => {
    const operation = fc.oneof(
      fc.record({
        kind: fc.constant('purchase' as const),
        amount: fc.integer({ min: 1, max: 40_000 }),
      }),
      fc.record({
        kind: fc.constant('deferred' as const),
        amount: fc.integer({ min: 5_000, max: 40_000 }),
      }),
      fc.record({
        kind: fc.constant('payment' as const),
        amount: fc.integer({ min: 1, max: 40_000 }),
      }),
      fc.record({ kind: fc.constant('reverse' as const), index: fc.nat(10) }),
    );

    await fc.assert(
      fc.asyncProperty(
        fc.array(operation, { minLength: 1, maxLength: 25 }),
        async (ops: Op[]) => {
          const custodyId = randomUUID();
          ctx.custody.seed(custodyId, 'user-1', 100_000);
          const created = await http()
            .post('/cards')
            .set('Authorization', `Bearer ${await userToken('user-1')}`)
            .set('Idempotency-Key', randomUUID())
            .send({ custodyAccountId: custodyId, cycleDay: 1 });
          const accountId = created.body.id as string;
          const network = await serviceToken([SCOPES.authorizationsWrite]);
          const owner = await userToken('user-1');

          let principal = 0;
          let deferred = 0;
          const approved: {
            id: string;
            amount: number;
            deferred: boolean;
            reversed: boolean;
          }[] = [];

          for (const op of ops) {
            if (op.kind === 'purchase' || op.kind === 'deferred') {
              const isDeferred = op.kind === 'deferred';
              const res = await http()
                .post(`/accounts/${accountId}/authorizations`)
                .set('Authorization', `Bearer ${network}`)
                .set('Idempotency-Key', randomUUID())
                .send({
                  amount: op.amount,
                  ...(isDeferred ? { installments: 3 } : {}),
                });
              const shouldApprove = op.amount <= CUPO - principal - deferred;
              expect(res.body.status).toBe(
                shouldApprove ? 'APPROVED' : 'DECLINED',
              );
              if (shouldApprove) {
                if (isDeferred) deferred += op.amount;
                else principal += op.amount;
                approved.push({
                  id: res.body.authorizationId,
                  amount: op.amount,
                  deferred: isDeferred,
                  reversed: false,
                });
              }
            } else if (op.kind === 'payment') {
              const res = await http()
                .post(`/accounts/${accountId}/payments`)
                .set('Authorization', `Bearer ${owner}`)
                .set('Idempotency-Key', randomUUID())
                .send({ amount: op.amount });
              if (op.amount <= principal) {
                expect(res.status).toBe(201);
                principal -= op.amount;
              } else {
                expect(res.status).toBe(422);
              }
            } else if (approved.length > 0) {
              const target = approved[op.index % approved.length];
              const res = await http()
                .post(
                  `/accounts/${accountId}/authorizations/${target.id}/reversals`,
                )
                .set('Authorization', `Bearer ${network}`)
                .set('Idempotency-Key', randomUUID())
                .send();
              if (target.reversed) {
                expect(res.status).toBe(409);
              } else if (!target.deferred && principal < target.amount) {
                expect(res.status).toBe(422);
              } else {
                expect(res.status).toBe(201);
                if (target.deferred) deferred -= target.amount;
                else principal -= target.amount;
                target.reversed = true;
              }
            }

            const debt = principal + deferred;
            const view = await http()
              .get(`/accounts/${accountId}`)
              .set('Authorization', `Bearer ${owner}`);
            expect(view.body.balances).toMatchObject({
              principal,
              deferred,
              debt,
            });
            expect(view.body.availableCredit).toBe(CUPO - debt);
            expect(debt).toBeGreaterThanOrEqual(0);
            expect(debt).toBeLessThanOrEqual(CUPO);
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
                (total, m) =>
                  total + (m.direction === 'DEBIT' ? m.amount : -m.amount),
                0n,
              );
          expect(account.principal).toBe(sum('PRINCIPAL'));
          expect(account.deferred).toBe(sum('DEFERRED'));
          expect(account.principal).toBe(BigInt(principal));
          expect(account.deferred).toBe(BigInt(deferred));
        },
      ),
      { numRuns: 30 },
    );
  });
});
