import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const token = execFileSync('node', [join(root, 'scripts', 'mint-token.mjs'), '--sub=scheduler', '--principal=service', '--scope=jobs:run', '--ttl=5m'])
  .toString()
  .trim();
const response = await fetch(`${process.env.LENDING_URL ?? 'http://localhost:3000'}/internal/jobs/daily`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}` },
});
console.log(response.status, await response.text());
