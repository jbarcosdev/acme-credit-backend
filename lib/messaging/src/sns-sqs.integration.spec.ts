import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  CreateTopicCommand,
  SNSClient,
  SubscribeCommand,
} from '@aws-sdk/client-sns';
import type { EventEnvelope } from '@acme/contracts';
import { awsConfigFromEnv } from './aws-config.js';
import { SnsEventPublisher } from './sns-event-publisher.js';
import { SqsEventConsumer } from './sqs-event-consumer.js';

const config = {
  ...awsConfigFromEnv({
    ...process.env,
    AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
  }),
};
const sns = new SNSClient(config);
const sqs = new SQSClient(config);

const event = (type = 'custody.limit-changed'): EventEnvelope => ({
  id: randomUUID(),
  type,
  version: 1,
  occurredAt: new Date().toISOString(),
  payload: { custodyAccountId: randomUUID(), version: 1 },
});

async function until(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('condition not met in time');
}

async function setup() {
  const suffix = randomUUID().slice(0, 8);
  const topicArn = (
    await sns.send(new CreateTopicCommand({ Name: `topic-${suffix}` }))
  ).TopicArn as string;
  const dlqUrl = (
    await sqs.send(new CreateQueueCommand({ QueueName: `dlq-${suffix}` }))
  ).QueueUrl as string;
  const dlqArn = (
    await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ['QueueArn'],
      }),
    )
  ).Attributes?.QueueArn as string;
  const queueUrl = (
    await sqs.send(
      new CreateQueueCommand({
        QueueName: `queue-${suffix}`,
        Attributes: {
          VisibilityTimeout: '1',
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: '2',
          }),
        },
      }),
    )
  ).QueueUrl as string;
  const queueArn = (
    await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['QueueArn'],
      }),
    )
  ).Attributes?.QueueArn as string;
  await sns.send(
    new SubscribeCommand({
      TopicArn: topicArn,
      Protocol: 'sqs',
      Endpoint: queueArn,
      Attributes: { RawMessageDelivery: 'true' },
    }),
  );
  return {
    publisher: new SnsEventPublisher(sns, topicArn),
    consumer: new SqsEventConsumer(sqs, { queueUrl, waitTimeSeconds: 1 }),
    queueUrl,
    dlqUrl,
  };
}

describe('SNS to SQS adapters (LocalStack)', () => {
  it('delivers a published event to the subscribed handler and removes it from the queue', async () => {
    const { publisher, consumer, queueUrl } = await setup();
    const received: EventEnvelope[] = [];
    consumer.subscribe(
      'custody.limit-changed',
      async (e) => void received.push(e),
    );
    await consumer.start();
    const sent = event();
    await publisher.publish(sent);
    await until(() => received.length === 1);
    expect(received[0]).toEqual(sent);
    await consumer.stop();
    const left = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 2 }),
    );
    expect(left.Messages ?? []).toHaveLength(0);
  });

  it('redelivers a message whose handler failed', async () => {
    const { publisher, consumer } = await setup();
    let attempts = 0;
    const done: string[] = [];
    consumer.subscribe('custody.limit-changed', async (e) => {
      if (++attempts === 1) throw new Error('boom');
      done.push(e.id);
    });
    await consumer.start();
    const sent = event();
    await publisher.publish(sent);
    await until(() => done.length === 1);
    expect(attempts).toBe(2);
    expect(done[0]).toBe(sent.id);
    await consumer.stop();
  });

  it('moves a message that keeps failing to the dead-letter queue', async () => {
    const { publisher, consumer, dlqUrl } = await setup();
    let attempts = 0;
    consumer.subscribe('custody.limit-changed', async () => {
      attempts++;
      throw new Error('always');
    });
    await consumer.start();
    const sent = event();
    await publisher.publish(sent);
    let body: string | undefined;
    await until(async () => {
      const res = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: dlqUrl, WaitTimeSeconds: 1 }),
      );
      body = res.Messages?.[0]?.Body;
      return Boolean(body);
    }, 20_000);
    expect(JSON.parse(body as string).id).toBe(sent.id);
    expect(attempts).toBe(2);
    await consumer.stop();
    await sqs
      .send(new PurgeQueueCommand({ QueueUrl: dlqUrl }))
      .catch(() => undefined);
  });
});
