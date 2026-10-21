import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { UnprocessableError } from './errors.js';
import type { SqlTx } from './sql.js';

export interface IdempotentResult<T> {
  statusCode: number;
  body: T;
}

export interface IdempotencyParams {
  scope: string;
  ownerId: string;
  key: string;
  request: unknown;
}

interface StoredRow {
  request_hash: string;
  status_code: number | null;
  response: unknown;
}

function canonical(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

@Injectable()
export class IdempotencyService {
  async execute<T>(
    tx: SqlTx,
    params: IdempotencyParams,
    handler: () => Promise<IdempotentResult<T>>,
  ): Promise<IdempotentResult<T> & { replayed: boolean }> {
    const hash = createHash('sha256')
      .update(canonical(params.request))
      .digest('hex');
    const inserted = await tx.$executeRaw`
      INSERT INTO idempotency_keys (scope, owner_id, key, request_hash)
      VALUES (${params.scope}, ${params.ownerId}, ${params.key}, ${hash})
      ON CONFLICT DO NOTHING`;

    if (inserted === 0) {
      const rows = await tx.$queryRaw<StoredRow[]>`
        SELECT request_hash, status_code, response FROM idempotency_keys
        WHERE scope = ${params.scope} AND owner_id = ${params.ownerId} AND key = ${params.key}`;
      const stored = rows[0];
      if (!stored || stored.request_hash !== hash) {
        throw new UnprocessableError(
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency key was used with a different request',
        );
      }
      return {
        statusCode: stored.status_code ?? 200,
        body: stored.response as T,
        replayed: true,
      };
    }

    const result = await handler();
    const response = JSON.stringify(result.body ?? null);
    await tx.$executeRaw`
      UPDATE idempotency_keys SET status_code = ${result.statusCode}, response = ${response}::jsonb
      WHERE scope = ${params.scope} AND owner_id = ${params.ownerId} AND key = ${params.key}`;
    return { ...result, replayed: false };
  }
}
