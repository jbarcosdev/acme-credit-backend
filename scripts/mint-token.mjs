import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importPKCS8, SignJWT } from 'jose';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => a.slice(2).split('=')),
);
const sub = args.sub ?? 'user-1';
const principal = args.principal ?? 'user';
const scope = args.scope ?? '';

const key = await importPKCS8(readFileSync(join(root, '.dev', 'keys', 'auth.private.pem'), 'utf8'), 'EdDSA');
const token = await new SignJWT({ scope, principal })
  .setProtectedHeader({ alg: 'EdDSA' })
  .setSubject(sub)
  .setIssuer(process.env.AUTH_ISSUER ?? 'https://idp.local')
  .setAudience(process.env.AUTH_AUDIENCE ?? 'acme-credit')
  .setIssuedAt()
  .setExpirationTime(args.ttl ?? '1h')
  .sign(key);
console.log(token);
