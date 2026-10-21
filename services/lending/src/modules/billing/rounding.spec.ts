import {
  divRoundHalfEven,
  interestFor,
  minimumPaymentFor,
} from './rounding.js';
import { addDays, daysBetween, nextCutDate } from './dates.js';

describe('rounding', () => {
  it('rounds half to even', () => {
    expect(divRoundHalfEven(5n, 2n)).toBe(2n);
    expect(divRoundHalfEven(7n, 2n)).toBe(4n);
    expect(divRoundHalfEven(10n, 4n)).toBe(2n);
    expect(divRoundHalfEven(11n, 4n)).toBe(3n);
    expect(divRoundHalfEven(9n, 3n)).toBe(3n);
  });

  it('computes interest from the sum of daily balances', () => {
    expect(interestFor(100_000n * 30n, 3600)).toBe(2959n);
    expect(interestFor(0n, 3600)).toBe(0n);
    expect(interestFor(100_000n * 365n, 3600)).toBe(36_000n);
  });

  it('computes the minimum payment with floor and cap', () => {
    expect(minimumPaymentFor(100_000n, 500, 2_500n)).toBe(5_000n);
    expect(minimumPaymentFor(10_000n, 500, 2_500n)).toBe(2_500n);
    expect(minimumPaymentFor(1_000n, 500, 2_500n)).toBe(1_000n);
    expect(minimumPaymentFor(0n, 500, 2_500n)).toBe(0n);
  });
});

describe('dates', () => {
  it('finds the next cut date strictly after a date', () => {
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    expect(iso(nextCutDate(new Date('2026-01-10T12:00:00Z'), 15))).toBe(
      '2026-01-15',
    );
    expect(iso(nextCutDate(new Date('2026-01-15T00:00:00Z'), 15))).toBe(
      '2026-02-15',
    );
    expect(iso(nextCutDate(new Date('2026-01-10T12:00:00Z'), 1))).toBe(
      '2026-02-01',
    );
    expect(iso(nextCutDate(new Date('2026-12-20T00:00:00Z'), 1))).toBe(
      '2027-01-01',
    );
    expect(iso(nextCutDate(new Date('2026-12-20T00:00:00Z'), 15))).toBe(
      '2027-01-15',
    );
  });

  it('adds and counts days', () => {
    const a = new Date('2026-01-01T00:00:00Z');
    expect(daysBetween(a, addDays(a, 31))).toBe(31);
  });
});
