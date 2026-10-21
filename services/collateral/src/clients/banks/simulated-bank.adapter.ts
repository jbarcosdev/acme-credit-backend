import { createPublicKey, verify } from 'node:crypto';
import {
  BankAdapter,
  InvalidWebhookError,
  type BankDepositEvent,
  type WebhookHeaders,
} from './bank-adapter.js';

export interface SimulatedBankOptions {
  bankId: string;
  publicKeyPem: string;
  toleranceSeconds?: number;
}

function header(headers: WebhookHeaders, name: string): string {
  const value = headers[name];
  const single = Array.isArray(value) ? value[0] : value;
  if (!single) throw new InvalidWebhookError(`missing ${name}`);
  return single;
}

export class SimulatedBankAdapter extends BankAdapter {
  readonly bankId: string;
  private readonly publicKey;

  constructor(private readonly options: SimulatedBankOptions) {
    super();
    this.bankId = options.bankId;
    this.publicKey = createPublicKey(options.publicKeyPem);
  }

  parseWebhook(
    rawBody: Buffer,
    headers: WebhookHeaders,
    now: Date,
  ): BankDepositEvent {
    const timestamp = header(headers, 'x-bank-timestamp');
    const signature = header(headers, 'x-bank-signature');

    const sentAt = Number(timestamp);
    if (
      !Number.isFinite(sentAt) ||
      Math.abs(now.getTime() / 1000 - sentAt) >
        (this.options.toleranceSeconds ?? 300)
    ) {
      throw new InvalidWebhookError('stale timestamp');
    }

    const signed = Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]);
    if (
      !verify(null, signed, this.publicKey, Buffer.from(signature, 'base64'))
    ) {
      throw new InvalidWebhookError('bad signature');
    }

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
      bankId: this.bankId,
      eventId,
      reference,
      amount: BigInt(amount),
      currency,
      occurredAt: new Date(occurredAt),
    };
  }
}
