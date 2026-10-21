import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { EventEnvelope } from '@acme/contracts';
import { EventConsumer, type EventHandler } from './event-consumer.js';

export interface SqsEventConsumerOptions {
  queueUrl: string;
  waitTimeSeconds?: number;
  maxMessages?: number;
  onError?: (error: unknown, event?: EventEnvelope) => void;
}

export class SqsEventConsumer extends EventConsumer {
  private readonly handlers = new Map<string, EventHandler[]>();
  private running = false;
  private loop?: Promise<void>;
  private abort?: AbortController;

  constructor(
    private readonly client: SQSClient,
    private readonly options: SqsEventConsumerOptions,
  ) {
    super();
  }

  subscribe(eventType: string, handler: EventHandler): void {
    const list = this.handlers.get(eventType) ?? [];
    list.push(handler);
    this.handlers.set(eventType, list);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loop = this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.loop;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const response = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.options.queueUrl,
            MaxNumberOfMessages: this.options.maxMessages ?? 10,
            WaitTimeSeconds: this.options.waitTimeSeconds ?? 20,
          }),
          { abortSignal: this.abort?.signal },
        );
        for (const message of response.Messages ?? [])
          await this.process(message);
      } catch (error) {
        if (!this.running) return;
        this.options.onError?.(error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async process(message: Message): Promise<void> {
    let event: EventEnvelope | undefined;
    try {
      event = this.parse(message.Body ?? '');
      for (const handler of this.handlers.get(event.type) ?? [])
        await handler(event);
      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: this.options.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    } catch (error) {
      this.options.onError?.(error, event);
    }
  }

  private parse(body: string): EventEnvelope {
    const parsed = JSON.parse(body);
    return (
      typeof parsed.Message === 'string' ? JSON.parse(parsed.Message) : parsed
    ) as EventEnvelope;
  }
}
