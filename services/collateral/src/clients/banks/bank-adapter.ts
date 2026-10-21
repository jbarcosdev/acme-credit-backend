export interface BankDepositEvent {
  bankId: string;
  eventId: string;
  reference: string;
  amount: bigint;
  currency: string;
  occurredAt: Date;
}

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export class InvalidWebhookError extends Error {}

export abstract class BankAdapter {
  abstract readonly bankId: string;
  abstract parseWebhook(
    rawBody: Buffer,
    headers: WebhookHeaders,
    now: Date,
  ): BankDepositEvent;
  getDepositStatus?(
    reference: string,
  ): Promise<'CONFIRMED' | 'PENDING' | 'UNKNOWN'>;
}
