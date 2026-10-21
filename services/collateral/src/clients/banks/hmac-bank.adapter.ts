import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  BankAdapter,
  InvalidWebhookError,
  type BankDepositEvent,
  type WebhookHeaders,
} from './bank-adapter.js';
import {
  assertFresh,
  header,
  parseDepositPayload,
  signedPayload,
} from './webhook-common.js';

export interface HmacBankOptions {
  bankId: string;
  secret: string;
  toleranceSeconds?: number;
}

export class HmacBankAdapter extends BankAdapter {
  readonly bankId: string;

  constructor(private readonly options: HmacBankOptions) {
    super();
    if (options.secret.length < 16)
      throw new Error('HMAC secrets must be at least 16 characters long');
    this.bankId = options.bankId;
  }

  parseWebhook(
    rawBody: Buffer,
    headers: WebhookHeaders,
    now: Date,
  ): BankDepositEvent {
    const timestamp = header(headers, 'x-bank-timestamp');
    const signature = header(headers, 'x-bank-signature');
    assertFresh(timestamp, now, this.options.toleranceSeconds ?? 300);

    const expected = createHmac('sha256', this.options.secret)
      .update(signedPayload(timestamp, rawBody))
      .digest();
    const received = Buffer.from(signature, 'hex');
    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      throw new InvalidWebhookError('bad signature');
    }
    return parseDepositPayload(this.bankId, rawBody);
  }
}
