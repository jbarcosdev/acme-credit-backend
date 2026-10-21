import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { SqlTx } from './sql.js';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string;
  data?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(private readonly cls: ClsService) {}

  async record(tx: SqlTx, entry: AuditEntry): Promise<void> {
    const actor = this.cls.isActive()
      ? this.cls.get<{ id: string; type: string }>('actor')
      : undefined;
    const correlationId = this.cls.isActive() ? this.cls.getId() : undefined;
    const data = JSON.stringify(entry.data ?? {});
    await tx.$executeRaw`
      INSERT INTO audit_log (actor_id, actor_type, action, entity_type, entity_id, correlation_id, data)
      VALUES (${actor?.id ?? 'system'}, ${actor?.type ?? 'system'}, ${entry.action}, ${entry.entityType},
              ${entry.entityId}, ${correlationId ?? null}, ${data}::jsonb)`;
  }
}
