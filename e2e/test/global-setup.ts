import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export default function setup() {
  for (const service of ['lending', 'collateral']) {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: join(root, 'services', service),
      env: { ...process.env, DATABASE_URL: `postgresql://${service}:${service}@localhost:5432/${service}_test` },
      stdio: 'pipe',
    });
  }
}
