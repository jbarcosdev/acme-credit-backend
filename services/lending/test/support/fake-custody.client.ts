import type {
  CustodyLimitResponse,
  LimitReductionResponse,
  SettlementResponse,
} from '@acme/contracts';
import {
  CustodyClient,
  CustodyRejectedError,
  CustodyUnavailableError,
} from '../../src/clients/custody/custody.client.js';

export class FakeCustodyClient extends CustodyClient {
  readonly accounts = new Map<
    string,
    CustodyLimitResponse & { held: number }
  >();
  readonly settlements: { id: string; key: string; applyAmount: number }[] = [];
  readonly reductions: { id: string; key: string; newCupo: number }[] = [];
  down = false;
  calls = 0;
  ratioBps = 9000;

  seed(id: string, ownerId: string, held: number, version = 1) {
    this.accounts.set(id, {
      custodyAccountId: id,
      ownerId,
      currency: 'USD',
      cupo: Math.floor((held * this.ratioBps) / 10_000),
      version,
      held,
    });
  }

  setHeld(id: string, held: number) {
    const account = this.accounts.get(id)!;
    account.held = held;
    account.cupo = Math.floor((held * this.ratioBps) / 10_000);
    account.version += 1;
  }

  async getLimit(id: string): Promise<CustodyLimitResponse> {
    this.calls++;
    if (this.down) throw new CustodyUnavailableError('down');
    const account = this.accounts.get(id);
    if (!account)
      throw new CustodyRejectedError(
        404,
        'CUSTODY_ACCOUNT_NOT_FOUND',
        'not found',
      );
    const { held: _held, ...limit } = account;
    return { ...limit };
  }

  async settle(
    id: string,
    key: string,
    applyAmount: number,
  ): Promise<SettlementResponse> {
    if (this.down) throw new CustodyUnavailableError('down');
    const account = this.accounts.get(id);
    if (!account)
      throw new CustodyRejectedError(
        404,
        'CUSTODY_ACCOUNT_NOT_FOUND',
        'not found',
      );
    this.settlements.push({ id, key, applyAmount });
    const applied = Math.min(applyAmount, account.held);
    const released = account.held - applied;
    account.held = 0;
    account.cupo = 0;
    account.version += 1;
    return { applied, released };
  }

  async reduceLimit(
    id: string,
    key: string,
    newCupo: number,
  ): Promise<LimitReductionResponse> {
    if (this.down) throw new CustodyUnavailableError('down');
    const account = this.accounts.get(id);
    if (!account)
      throw new CustodyRejectedError(
        404,
        'CUSTODY_ACCOUNT_NOT_FOUND',
        'not found',
      );
    this.reductions.push({ id, key, newCupo });
    const required = Math.ceil((newCupo * 10_000) / this.ratioBps);
    const released = account.held - required;
    account.held = required;
    account.cupo = Math.floor((required * this.ratioBps) / 10_000);
    account.version += 1;
    return { cupo: account.cupo, version: account.version, released };
  }
}
