import type { EventEnvelope } from '@acme/contracts';

export type EventHandler = (event: EventEnvelope) => Promise<void>;

export abstract class EventConsumer {
  abstract subscribe(eventType: string, handler: EventHandler): void;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
}
