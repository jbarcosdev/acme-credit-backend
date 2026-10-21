import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AccountRow } from './account-types.js';

export interface PaymentHook {
  afterPayment(
    tx: Prisma.TransactionClient,
    account: AccountRow,
  ): Promise<void>;
}

@Injectable()
export class PaymentHooks {
  private readonly hooks: PaymentHook[] = [];

  register(hook: PaymentHook): void {
    this.hooks.push(hook);
  }

  async run(tx: Prisma.TransactionClient, account: AccountRow): Promise<void> {
    for (const hook of this.hooks) await hook.afterPayment(tx, account);
  }
}
