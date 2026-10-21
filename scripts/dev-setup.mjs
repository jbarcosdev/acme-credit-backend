import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const keysDir = join(root, '.dev', 'keys');
mkdirSync(keysDir, { recursive: true });

function ensureKeyPair(name) {
  const publicPath = join(keysDir, `${name}.public.pem`);
  const privatePath = join(keysDir, `${name}.private.pem`);
  if (!existsSync(publicPath) || !existsSync(privatePath)) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }));
    writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  return { public: readFileSync(publicPath, 'utf8'), private: readFileSync(privatePath, 'utf8') };
}

const quoted = (pem) => `"${pem.trim().replace(/\n/g, '\\n')}"`;
const auth = ensureKeyPair('auth');
const bank = ensureKeyPair('bank');

function writeEnv(service, values) {
  const example = readFileSync(join(root, 'services', service, '.env.example'), 'utf8');
  const lines = example.split('\n').map((line) => {
    const [key] = line.split('=');
    return key in values ? `${key}=${values[key]}` : line;
  });
  const target = join(root, 'services', service, '.env');
  writeFileSync(target, lines.join('\n'));
  console.log(`wrote ${target}`);
}

writeEnv('lending', { AUTH_PUBLIC_KEY: quoted(auth.public), SERVICE_PRIVATE_KEY: quoted(auth.private) });
writeEnv('collateral', { AUTH_PUBLIC_KEY: quoted(auth.public), BANK_SIM_PUBLIC_KEY: quoted(bank.public) });
