export function divRoundHalfEven(
  numerator: bigint,
  denominator: bigint,
): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twice = remainder * 2n;
  if (twice > denominator || (twice === denominator && quotient % 2n !== 0n))
    return quotient + 1n;
  return quotient;
}

const DAYS_BASIS = 365n;
const BPS = 10_000n;

export function interestFor(
  sumOfDailyBalances: bigint,
  aprBps: number,
): bigint {
  return divRoundHalfEven(
    sumOfDailyBalances * BigInt(aprBps),
    BPS * DAYS_BASIS,
  );
}

export function minimumPaymentFor(
  closingBalance: bigint,
  minPaymentBps: number,
  floor: bigint,
): bigint {
  if (closingBalance <= 0n) return 0n;
  const percentage = divRoundHalfEven(
    closingBalance * BigInt(minPaymentBps),
    BPS,
  );
  const minimum = percentage > floor ? percentage : floor;
  return minimum < closingBalance ? minimum : closingBalance;
}
