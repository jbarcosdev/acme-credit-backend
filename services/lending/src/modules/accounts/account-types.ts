export type AccountStatus = 'ACTIVE' | 'DELINQUENT' | 'CLOSING' | 'CLOSED';
export type MovementKind =
  | 'PURCHASE'
  | 'REVERSAL'
  | 'PAYMENT'
  | 'INTEREST'
  | 'LATE_FEE'
  | 'COLLATERAL_APPLICATION'
  | 'INSTALLMENT_PRINCIPAL'
  | 'INSTALLMENT_INTEREST';
export type BucketName = 'PRINCIPAL' | 'DEFERRED' | 'INTEREST' | 'FEES';
export type DirectionName = 'DEBIT' | 'CREDIT';

export interface AccountRow {
  id: string;
  owner_id: string;
  custody_account_id: string;
  currency: string;
  status: AccountStatus;
  principal: bigint;
  deferred: bigint;
  interest: bigint;
  fees: bigint;
  limit_cap: bigint | null;
  limit_cap_settled_at: Date | null;
  cycle_day: number;
  terms_version: number;
}

export interface MovementEntry {
  type: MovementKind;
  bucket: BucketName;
  direction: DirectionName;
  amount: bigint;
  referenceMovementId?: string;
  statementId?: string;
  note?: string;
  installments?: number;
  rateBps?: number;
  effectiveAt?: Date;
}

export function debtOf(
  account: Pick<AccountRow, 'principal' | 'deferred' | 'interest' | 'fees'>,
): bigint {
  return account.principal + account.deferred + account.interest + account.fees;
}

export function payableOf(
  account: Pick<AccountRow, 'principal' | 'interest' | 'fees'>,
): bigint {
  return account.principal + account.interest + account.fees;
}

export function effectiveLimit(cupo: bigint, cap: bigint | null): bigint {
  return cap !== null && cap < cupo ? cap : cupo;
}

export function availableCredit(
  cupo: bigint,
  cap: bigint | null,
  debt: bigint,
): bigint {
  const available = effectiveLimit(cupo, cap) - debt;
  return available > 0n ? available : 0n;
}
