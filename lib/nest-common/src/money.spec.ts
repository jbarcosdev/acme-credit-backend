import { fromMinor, toMinor } from './money.js';

describe('money', () => {
  it('converts safe integers to bigint and back', () => {
    expect(toMinor(12345)).toBe(12345n);
    expect(fromMinor(12345n)).toBe(12345);
  });

  it('rejects fractions and unsafe values', () => {
    expect(() => toMinor(1.5)).toThrow(RangeError);
    expect(() => toMinor(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
    expect(() => fromMinor(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(
      RangeError,
    );
  });
});
