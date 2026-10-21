import { createHmac, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importPKCS8, SignJWT } from 'jose';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const keyPath = (name) => join(root, '.dev', 'keys', name);

export const urls = {
  collateral: process.env.COLLATERAL_URL ?? 'http://localhost:3001',
  lending: process.env.LENDING_URL ?? 'http://localhost:3000',
};

export function parseArgs(argv = process.argv.slice(2)) {
  return Object.fromEntries(
    argv
      .filter((a) => a.startsWith('--') && a.length > 2)
      .map((a) => {
        const [key, ...rest] = a.slice(2).split('=');
        return [key, rest.length ? rest.join('=') : 'true'];
      }),
  );
}

export function requireDevKeys() {
  if (!existsSync(keyPath('auth.private.pem'))) {
    console.error('No hay llaves de desarrollo. Ejecuta primero: pnpm dev:setup');
    process.exit(2);
  }
}

export async function mint(sub, principal = 'user', scope = '', ttl = '1h') {
  requireDevKeys();
  const key = await importPKCS8(readFileSync(keyPath('auth.private.pem'), 'utf8'), 'EdDSA');
  return new SignJWT({ scope, principal })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(sub)
    .setIssuer(process.env.AUTH_ISSUER ?? 'https://idp.local')
    .setAudience(process.env.AUTH_AUDIENCE ?? 'acme-credit')
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(key);
}

export const tokens = {
  user: (sub, ttl) => mint(sub, 'user', '', ttl),
  network: (ttl) => mint('card-network', 'service', 'authorizations:write', ttl),
  scheduler: (ttl) => mint('scheduler', 'service', 'jobs:run', ttl),
};

export async function call(base, method, path, { auth, body, key, headers } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      'content-type': 'application/json',
      ...(key ? { 'idempotency-key': key } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

export function signWebhook(payload, { bank = 'sim-bank', forged = false } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const data = Buffer.from(`${timestamp}.${body}`);
  let signature;
  if (bank === 'hmac-bank') {
    const secret = readFileSync(keyPath('bank-hmac.secret'), 'utf8').trim();
    signature = createHmac('sha256', forged ? 'forged-secret-0123456789' : secret).update(data).digest('hex');
  } else {
    const privateKey = createPrivateKey(readFileSync(keyPath('bank.private.pem'), 'utf8'));
    signature = (forged ? Buffer.from('forged') : sign(null, data, privateKey)).toString('base64');
  }
  return { body, headers: { 'x-bank-timestamp': timestamp, 'x-bank-signature': signature } };
}

export function bankConfirm({ reference, amount, eventId = randomUUID(), bank = 'sim-bank', currency = 'USD', forged = false, occurredAt = new Date().toISOString() }) {
  const { body, headers } = signWebhook(
    { eventId, reference, amount, currency, occurredAt },
    { bank, forged },
  );
  return call(urls.collateral, 'POST', `/webhooks/banks/${bank}`, { body, headers });
}

export async function isReady() {
  const [a, b] = await Promise.all(
    [urls.collateral, urls.lending].map((base) => call(base, 'GET', '/health/ready').catch(() => ({ status: 0 }))),
  );
  return a.status === 200 && b.status === 200;
}

export async function waitUntilReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isReady()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

export async function until(read, accept, timeoutMs = 15_000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!accept(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    last = await read();
  }
  return last;
}

export { randomUUID };
