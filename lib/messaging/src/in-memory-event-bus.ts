import type { EventEnvelope } from '@acme/contracts';
import { EventConsumer, type EventHandler } from './event-consumer.js';
import { EventPublisher } from './event-publisher.js';

export interface InMemoryEventBusOptions {
  maxAttempts?: number;
  autoDeliver?: boolean;
}

export class InMemoryEventBus extends EventPublisher implements EventConsumer {
  readonly published: EventEnvelope[] = [];
  readonly deadLetters: EventEnvelope[] = [];
  private readonly handlers = new Map<string, EventHandler[]>();
  private pending: EventEnvelope[] = [];
  private running = false;

  constructor(private readonly options: InMemoryEventBusOptions = {}) {
    super();
  }

  subscribe(eventType: string, handler: EventHandler): void {
    const list = this.handlers.get(eventType) ?? [];
    list.push(handler);
    this.handlers.set(eventType, list);
  }

  async start(): Promise<void> {
    this.running = true;
    await this.flush();
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async publish(event: EventEnvelope): Promise<void> {
    this.published.push(event);
    this.pending.push(event);
    if (this.running && this.options.autoDeliver !== false) await this.flush();
  }

  async flush(): Promise<void> {
    const maxAttempts = this.options.maxAttempts ?? 3;
    const batch = this.pending;
    this.pending = [];
    for (const event of batch) {
      for (const handler of this.handlers.get(event.type) ?? []) {
        let delivered = false;
        for (let attempt = 1; attempt <= maxAttempts && !delivered; attempt++) {
          try {
            await handler(event);
            delivered = true;
          } catch {
            delivered = false;
          }
        }
        if (!delivered) this.deadLetters.push(event);
      }
    }
  }
}
