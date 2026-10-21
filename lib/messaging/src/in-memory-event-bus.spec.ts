import type { EventEnvelope } from '@acme/contracts';
import { InMemoryEventBus } from './in-memory-event-bus.js';

const event = (type: string): EventEnvelope => ({
  id: crypto.randomUUID(),
  type,
  version: 1,
  occurredAt: new Date().toISOString(),
  payload: {},
});

describe('InMemoryEventBus', () => {
  it('delivers events to subscribers of the type', async () => {
    const bus = new InMemoryEventBus();
    const received: string[] = [];
    bus.subscribe('a', async (e) => void received.push(e.id));
    await bus.start();
    const a = event('a');
    await bus.publish(a);
    await bus.publish(event('b'));
    expect(received).toEqual([a.id]);
  });

  it('retries a failing handler and dead-letters after max attempts', async () => {
    const bus = new InMemoryEventBus({ maxAttempts: 3 });
    let calls = 0;
    bus.subscribe('a', async () => {
      calls++;
      throw new Error('boom');
    });
    await bus.start();
    await bus.publish(event('a'));
    expect(calls).toBe(3);
    expect(bus.deadLetters).toHaveLength(1);
  });

  it('succeeds when a retry works', async () => {
    const bus = new InMemoryEventBus({ maxAttempts: 3 });
    let calls = 0;
    bus.subscribe('a', async () => {
      if (++calls < 2) throw new Error('boom');
    });
    await bus.start();
    await bus.publish(event('a'));
    expect(calls).toBe(2);
    expect(bus.deadLetters).toHaveLength(0);
  });
});
