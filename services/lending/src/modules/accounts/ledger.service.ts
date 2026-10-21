import { Injectable } from '@nestjs/common';
import { NotFoundError, UnprocessableError } from '@acme/nest-common';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AccountRow, BucketName, MovementEntry } from './account-types.js';

type Tx = Prisma.TransactionClient;

const COLUMN: Record<
  BucketName,
  'principal' | 'deferred' | 'interest' | 'fees'
> = {
  PRINCIPAL: 'principal',
  DEFERRED: 'deferred',
  INTEREST: 'interest',
  FEES: 'fees',
};

@Injectable()
export class LedgerService {
  async lock(tx: Tx, id: string): Promise<AccountRow> {
    const rows = await tx.$queryRaw<AccountRow[]>`
      SELECT id, owner_id, custody_account_id, currency, status, principal, deferred, interest, fees,
             limit_cap, cycle_day, terms_version
      FROM card_accounts WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows[0])
      throw new NotFoundError('ACCOUNT_NOT_FOUND', 'Account not found');
    return rows[0];
  }

  async post(
    tx: Tx,
    account: AccountRow,
    entry: MovementEntry,
  ): Promise<{ account: AccountRow; movementId: string }> {
    const column = COLUMN[entry.bucket];
    const current = account[column];
    const next =
      entry.direction === 'DEBIT'
        ? current + entry.amount
        : current - entry.amount;
    if (next < 0n)
      throw new UnprocessableError(
        'BALANCE_UNDERFLOW',
        `The ${entry.bucket.toLowerCase()} balance cannot go below zero`,
      );

    await tx.cardAccount.update({
      where: { id: account.id },
      data: { [column]: next },
    });
    const movement = await tx.movement.create({
      data: {
        accountId: account.id,
        type: entry.type,
        bucket: entry.bucket,
        direction: entry.direction,
        amount: entry.amount,
        bucketBalanceAfter: next,
        referenceMovementId: entry.referenceMovementId,
        statementId: entry.statementId,
        note: entry.note,
      },
    });
    return { account: { ...account, [column]: next }, movementId: movement.id };
  }
}
