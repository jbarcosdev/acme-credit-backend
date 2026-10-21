import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { EventEnvelope } from '@acme/contracts';
import { EventPublisher } from '@acme/messaging';
import type { SqlDb, SqlTx } from './sql.js';

@Injectable()
export class OutboxService {
  constructor(private readonly cls: ClsService) {}

  async add(tx: SqlTx, type: string, payload: unknown): Promise<void> {
    const correlationId = this.cls.isActive() ? this.cls.getId() : null;
    const body = JSON.stringify(payload);
    await tx.$executeRaw`
      INSERT INTO outbox_events (type, payload, correlation_id) VALUES (${type}, ${body}::jsonb, ${correlationId})`;
  }
}

interface OutboxRow {
  id: string;
  type: string;
  payload: unknown;
  correlation_id: string | null;
  created_at: Date;
  attempts: number;
}

export interface OutboxPublisherOptions {
  intervalMs?: number;
  batchSize?: number;
  baseBackoffSeconds?: number;
  maxBackoffSeconds?: number;
}

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly db: SqlDb,
    private readonly publisher: EventPublisher,
    private readonly options: OutboxPublisherOptions = {},
  ) {}

  onModuleInit(): void {
    if (this.options.intervalMs === 0) return;
    this.timer = setInterval(
      () => void this.drain(),
      this.options.intervalMs ?? 1000,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async drain(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.db.$transaction(async (tx) => this.publishBatch(tx));
    } catch (error) {
      this.logger.error(error);
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async publishBatch(tx: SqlTx): Promise<number> {
    const rows = await tx.$queryRaw<OutboxRow[]>`
      SELECT id, type, payload, correlation_id, created_at, attempts FROM outbox_events
      WHERE published_at IS NULL AND next_attempt_at <= now()
      ORDER BY created_at
      LIMIT ${this.options.batchSize ?? 50}
      FOR UPDATE SKIP LOCKED`;

    let published = 0;
    for (const row of rows) {
      const event: EventEnvelope = {
        id: row.id,
        type: row.type,
        version: 1,
        occurredAt: new Date(row.created_at).toISOString(),
        correlationId: row.correlation_id ?? undefined,
        payload: row.payload,
      };
      try {
        await this.publisher.publish(event);
        await tx.$executeRaw`UPDATE outbox_events SET published_at = now() WHERE id = ${row.id}::uuid`;
        published++;
      } catch (error) {
        const attempts = row.attempts + 1;
        const base = this.options.baseBackoffSeconds ?? 2;
        const delay = Math.min(
          base * 2 ** (attempts - 1),
          this.options.maxBackoffSeconds ?? 300,
        );
        await tx.$executeRaw`
          UPDATE outbox_events
          SET attempts = ${attempts}, last_error = ${String(error)},
              next_attempt_at = now() + (${delay} * interval '1 second')
          WHERE id = ${row.id}::uuid`;
      }
    }
    return published;
  }
}
