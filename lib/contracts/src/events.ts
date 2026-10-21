export interface EventEnvelope<T = unknown> {
  id: string;
  type: string;
  version: number;
  occurredAt: string;
  correlationId?: string;
  payload: T;
}

export const EVENT_TYPES = {
  custodyLimitChanged: 'custody.limit-changed',
} as const;

export interface CustodyLimitChangedPayload {
  custodyAccountId: string;
  version: number;
}
