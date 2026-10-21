import { randomUUID, createPrivateKey, sign } from 'node:crypto';
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
  console.error('usage: simulate-bank-webhook --reference=DEP-... --amount=<minor units> [--eventId=...] [--currency=USD] [--url=http://localhost:3001]');
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
const privateKey = createPrivateKey(readFileSync(join(root, '.dev', 'keys', 'bank.private.pem'), 'utf8'));
const signature = sign(null, Buffer.from(`${timestamp}.${body}`), privateKey).toString('base64');

const response = await fetch(`${args.url ?? 'http://localhost:3001'}/webhooks/banks/sim-bank`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-bank-timestamp': timestamp, 'x-bank-signature': signature },
  body,
});
console.log(response.status, await response.text());
