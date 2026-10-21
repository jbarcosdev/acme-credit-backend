import { execSync } from 'node:child_process';
import 'dotenv/config';

export default function setup() {
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgresql://collateral:collateral@localhost:5432/collateral_test';
  execSync('pnpm exec prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
