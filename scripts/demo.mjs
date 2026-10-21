import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importPKCS8, SignJWT } from 'jose';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const custodyUrl = process.env.COLLATERAL_URL ?? 'http://localhost:3001';
const lendingUrl = process.env.LENDING_URL ?? 'http://localhost:3000';
const authKey = await importPKCS8(readFileSync(join(root, '.dev/keys/auth.private.pem'), 'utf8'), 'EdDSA');
const bankKey = createPrivateKey(readFileSync(join(root, '.dev/keys/bank.private.pem'), 'utf8'));

const token = (sub, principal, scope = '') =>
  new SignJWT({ scope, principal })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(sub)
    .setIssuer(process.env.AUTH_ISSUER ?? 'https://idp.local')
    .setAudience(process.env.AUTH_AUDIENCE ?? 'acme-credit')
    .setExpirationTime('10m')
    .sign(authKey);

async function call(base, method, path, { auth, body, key, headers } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

const step = (title, result) => console.log(`\n# ${title}\n${result.status}`, JSON.stringify(result.body));

const customer = `demo-${randomUUID().slice(0, 8)}`;
const user = await token(customer, 'user');
const network = await token('card-network', 'service', 'authorizations:write');

const custody = await call(custodyUrl, 'POST', '/custody-accounts', { auth: user, key: randomUUID(), body: {} });
step('open custody account', custody);

const deposit = await call(custodyUrl, 'POST', `/custody-accounts/${custody.body.id}/deposits`, {
  auth: user,
  key: randomUUID(),
  body: { bankId: 'sim-bank', amount: 100_000 },
});
step('create deposit (pending)', deposit);

const webhook = JSON.stringify({ eventId: randomUUID(), reference: deposit.body.reference, amount: 100_000, currency: 'USD', occurredAt: new Date().toISOString() });
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = sign(null, Buffer.from(`${timestamp}.${webhook}`), bankKey).toString('base64');
step('bank confirms the deposit (signed webhook)', await call(custodyUrl, 'POST', '/webhooks/banks/sim-bank', { auth: '', body: webhook, headers: { 'x-bank-timestamp': timestamp, 'x-bank-signature': signature } }));

const card = await call(lendingUrl, 'POST', '/cards', { auth: user, key: randomUUID(), body: { custodyAccountId: custody.body.id, cycleDay: 15 } });
step('request card (limit derived from the collateral)', card);

const purchase = (amount) => call(lendingUrl, 'POST', `/accounts/${card.body.id}/authorizations`, { auth: network, key: randomUUID(), body: { amount, merchant: 'demo shop' } });
step('purchase 60000', await purchase(60_000));
step('purchase 40000 (exceeds the available credit)', await purchase(40_000));
step('purchase 12000 in 3 installments (counts fully against the limit, billed later)', await call(lendingUrl, 'POST', `/accounts/${card.body.id}/authorizations`, { auth: network, key: randomUUID(), body: { amount: 12_000, installments: 3, merchant: 'demo store' } }));
step('pay 20000', await call(lendingUrl, 'POST', `/accounts/${card.body.id}/payments`, { auth: user, key: randomUUID(), body: { amount: 20_000 } }));
step('account', await call(lendingUrl, 'GET', `/accounts/${card.body.id}`, { auth: user }));
step('close account (collateral applied to the debt, the rest released)', await call(lendingUrl, 'POST', `/accounts/${card.body.id}/closure`, { auth: user, key: randomUUID() }));
step('custody account after closure', await call(custodyUrl, 'GET', `/custody-accounts/${custody.body.id}`, { auth: user }));
