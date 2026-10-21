import { bankConfirm, call, parseArgs, tokens, urls, waitUntilReady } from './lib/stack.mjs';

const args = parseArgs();
const userId = args.user ?? 'test-user';
const amount = Number(args.amount ?? 100_000);
const cycleDay = Number(args['cycle-day'] ?? 15);
const ttl = args.ttl ?? '12h';

if (!(await waitUntilReady(20_000))) {
  console.error('Los servicios no responden. Levántalos con: pnpm apps:up (o pnpm dev:lending y pnpm dev:collateral)');
  process.exit(2);
}

const user = await tokens.user(userId, ttl);
const fail = (step, result) => {
  console.error(`Falló "${step}": ${result.status} ${JSON.stringify(result.body)}`);
  process.exit(1);
};

const custody = await call(urls.collateral, 'POST', '/custody-accounts', { auth: user, key: `seed:${userId}:custody`, body: {} });
if (custody.status !== 201) fail('abrir cuenta de custodia', custody);

const deposit = await call(urls.collateral, 'POST', `/custody-accounts/${custody.body.id}/deposits`, {
  auth: user,
  key: `seed:${userId}:deposit`,
  body: { bankId: 'sim-bank', amount },
});
if (deposit.status !== 201) fail('crear depósito', deposit);

const confirmation = await bankConfirm({ reference: deposit.body.reference, amount, eventId: `seed:${userId}:event`, occurredAt: '2026-01-01T00:00:00.000Z' });
if (confirmation.status !== 200) fail('confirmar depósito', confirmation);

const card = await call(urls.lending, 'POST', '/cards', {
  auth: user,
  key: `seed:${userId}:card`,
  body: { custodyAccountId: custody.body.id, cycleDay },
});
if (card.status !== 201) fail('solicitar tarjeta', card);

const view = await call(urls.lending, 'GET', `/accounts/${card.body.id}`, { auth: user });

console.log(
  JSON.stringify(
    {
      urls,
      userId,
      custodyAccountId: custody.body.id,
      cardAccountId: card.body.id,
      depositReference: deposit.body.reference,
      deposited: amount,
      account: view.body,
      tokens: {
        user,
        cardNetwork: await tokens.network(ttl),
        scheduler: await tokens.scheduler(ttl),
      },
      tokenTtl: ttl,
    },
    null,
    2,
  ),
);
