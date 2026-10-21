import { FixedClock, OffsetClock } from './clock.js';

describe('clocks', () => {
  it('moves the offset clock forward and rejects going back', () => {
    const clock = new OffsetClock();
    const before = clock.now().getTime();
    clock.advanceDays(2);
    expect(clock.now().getTime() - before).toBeGreaterThanOrEqual(
      2 * 86_400_000,
    );
    expect(() => clock.advanceDays(-1)).toThrow(RangeError);
    expect(() => clock.advanceTo(new Date('2000-01-01T00:00:00Z'))).toThrow(
      RangeError,
    );
    clock.advanceTo(new Date(Date.now() + 5 * 86_400_000));
    expect(clock.now().getTime() - before).toBeGreaterThanOrEqual(
      5 * 86_400_000,
    );
  });

  it('keeps a fixed clock still until told otherwise', () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
    clock.advanceDays(1);
    expect(clock.now().toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });
});
