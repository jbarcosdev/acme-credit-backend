import { Injectable } from '@nestjs/common';
import { NotFoundError } from '@acme/nest-common';
import type { BankAdapter } from './bank-adapter.js';

@Injectable()
export class BankRegistry {
  private readonly adapters = new Map<string, BankAdapter>();

  constructor(adapters: BankAdapter[] = []) {
    for (const adapter of adapters) this.adapters.set(adapter.bankId, adapter);
  }

  has(bankId: string): boolean {
    return this.adapters.has(bankId);
  }

  get(bankId: string): BankAdapter {
    const adapter = this.adapters.get(bankId);
    if (!adapter)
      throw new NotFoundError('BANK_NOT_FOUND', `Unknown bank ${bankId}`);
    return adapter;
  }
}
