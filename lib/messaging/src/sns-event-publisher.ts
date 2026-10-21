import { PublishCommand, type SNSClient } from '@aws-sdk/client-sns';
import type { EventEnvelope } from '@acme/contracts';
import { EventPublisher } from './event-publisher.js';

export class SnsEventPublisher extends EventPublisher {
  constructor(
    private readonly client: SNSClient,
    private readonly topicArn: string,
  ) {
    super();
  }

  async publish(event: EventEnvelope): Promise<void> {
    await this.client.send(
      new PublishCommand({
        TopicArn: this.topicArn,
        Message: JSON.stringify(event),
        MessageAttributes: {
          type: { DataType: 'String', StringValue: event.type },
        },
      }),
    );
  }
}
