import { applyDecorators } from '@nestjs/common';
import { IsInt, Max, Min } from 'class-validator';

export function toMinor(value: number): bigint {
  if (!Number.isSafeInteger(value))
    throw new RangeError('amount must be a safe integer in minor units');
  return BigInt(value);
}

export function fromMinor(value: bigint): number {
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new RangeError('amount exceeds the safe integer range');
  }
  return Number(value);
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function IsMinorUnits(options: { min?: number } = {}) {
  return applyDecorators(
    IsInt(),
    Min(options.min ?? 1),
    Max(Number.MAX_SAFE_INTEGER),
  );
}
