import { createPublicKey, verify, type KeyObject } from 'node:crypto';
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

export interface Ed25519BankOptions {
  bankId: string;
  publicKeyPem: string;
  toleranceSeconds?: number;
}

export class Ed25519BankAdapter extends BankAdapter {
  readonly bankId: string;
  private readonly publicKey: KeyObject;

  constructor(private readonly options: Ed25519BankOptions) {
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
    assertFresh(timestamp, now, this.options.toleranceSeconds ?? 300);
    if (
      !verify(
        null,
        signedPayload(timestamp, rawBody),
        this.publicKey,
        Buffer.from(signature, 'base64'),
      )
    ) {
      throw new InvalidWebhookError('bad signature');
    }
    return parseDepositPayload(this.bankId, rawBody);
  }
}
