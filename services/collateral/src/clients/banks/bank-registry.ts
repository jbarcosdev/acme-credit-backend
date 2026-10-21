import { Injectable } from '@nestjs/common';
import { NotFoundError } from '@acme/nest-common';
import type { BankAdapter } from './bank-adapter.js';
import { Ed25519BankAdapter } from './ed25519-bank.adapter.js';
import { HmacBankAdapter } from './hmac-bank.adapter.js';

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

export function bankRegistryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BankRegistry {
  const adapters: BankAdapter[] = [];
  if (env.BANK_SIM_PUBLIC_KEY) {
    adapters.push(
      new Ed25519BankAdapter({
        bankId: 'sim-bank',
        publicKeyPem: env.BANK_SIM_PUBLIC_KEY.replace(/\\n/g, '\n'),
      }),
    );
  }
  if (env.BANK_HMAC_SECRET) {
    adapters.push(
      new HmacBankAdapter({
        bankId: 'hmac-bank',
        secret: env.BANK_HMAC_SECRET,
      }),
    );
  }
  return new BankRegistry(adapters);
}
