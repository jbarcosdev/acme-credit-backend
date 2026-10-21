import { randomUUID, createHmac, createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => a.slice(2).split('=')),
);
if (!args.reference || !args.amount) {
  console.error('usage: simulate-bank-webhook --reference=DEP-... --amount=<minor units> [--eventId=...] [--currency=USD] [--bank=sim-bank|hmac-bank] [--url=http://localhost:3001]');
  process.exit(1);
}

const body = JSON.stringify({
  eventId: args.eventId ?? randomUUID(),
  reference: args.reference,
  amount: Number(args.amount),
  currency: args.currency ?? 'USD',
  occurredAt: new Date().toISOString(),
});
const timestamp = String(Math.floor(Date.now() / 1000));
const bank = args.bank ?? 'sim-bank';
const payload = Buffer.from(`${timestamp}.${body}`);
const signature =
  bank === 'hmac-bank'
    ? createHmac('sha256', readFileSync(join(root, '.dev', 'keys', 'bank-hmac.secret'), 'utf8').trim()).update(payload).digest('hex')
    : sign(null, payload, createPrivateKey(readFileSync(join(root, '.dev', 'keys', 'bank.private.pem'), 'utf8'))).toString('base64');

const response = await fetch(`${args.url ?? 'http://localhost:3001'}/webhooks/banks/${bank}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-bank-timestamp': timestamp, 'x-bank-signature': signature },
  body,
});
console.log(response.status, await response.text());
