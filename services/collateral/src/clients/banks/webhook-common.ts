import {
  InvalidWebhookError,
  type BankDepositEvent,
  type WebhookHeaders,
} from './bank-adapter.js';

export function header(headers: WebhookHeaders, name: string): string {
  const value = headers[name];
  const single = Array.isArray(value) ? value[0] : value;
  if (!single) throw new InvalidWebhookError(`missing ${name}`);
  return single;
}

export function assertFresh(
  timestamp: string,
  now: Date,
  toleranceSeconds: number,
): void {
  const sentAt = Number(timestamp);
  if (
    !Number.isFinite(sentAt) ||
    Math.abs(now.getTime() / 1000 - sentAt) > toleranceSeconds
  ) {
    throw new InvalidWebhookError('stale timestamp');
  }
}

export function signedPayload(timestamp: string, rawBody: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]);
}

export function parseDepositPayload(
  bankId: string,
  rawBody: Buffer,
): BankDepositEvent {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new InvalidWebhookError('malformed body');
  }

  const { eventId, reference, amount, currency, occurredAt } = body;
  if (
    typeof eventId !== 'string' ||
    typeof reference !== 'string' ||
    typeof currency !== 'string' ||
    typeof occurredAt !== 'string' ||
    typeof amount !== 'number' ||
    !Number.isSafeInteger(amount) ||
    amount <= 0
  ) {
    throw new InvalidWebhookError('invalid payload');
  }
  return {
    bankId,
    eventId,
    reference,
    amount: BigInt(amount),
    currency,
    occurredAt: new Date(occurredAt),
  };
}
