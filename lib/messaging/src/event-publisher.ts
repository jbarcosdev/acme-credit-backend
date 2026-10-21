import type { EventEnvelope } from '@acme/contracts';

export abstract class EventPublisher {
  abstract publish(event: EventEnvelope): Promise<void>;
}
