import {
  annuityPayment,
  buildSchedule,
  installmentInterest,
} from './installments.js';

describe('installments', () => {
  it('splits a zero-rate purchase evenly and lets the last installment absorb the remainder', () => {
    const schedule = buildSchedule(10_001n, 3, 0);
    expect(schedule.map((b) => b.principal)).toEqual([3_334n, 3_334n, 3_333n]);
    expect(schedule.every((b) => b.interest === 0n)).toBe(true);
    expect(schedule.reduce((sum, b) => sum + b.principal, 0n)).toBe(10_001n);
  });

  it('computes the annuity payment for an interest-bearing plan', () => {
    expect(annuityPayment(100_000n, 12, 2400)).toBe(9_456n);
    expect(annuityPayment(100_000n, 6, 1800)).toBe(17_553n);
  });

  it('charges interest on the remaining principal and amortizes it fully', () => {
    const schedule = buildSchedule(100_000n, 12, 2400);
    expect(schedule[0].interest).toBe(2_000n);
    expect(schedule[0].principal).toBe(9_456n - 2_000n);
    expect(schedule.reduce((sum, b) => sum + b.principal, 0n)).toBe(100_000n);
    expect(schedule.map((b) => b.interest)).toEqual(
      [...schedule.map((b) => b.interest)].sort((a, b) => Number(b - a)),
    );
    expect(schedule.at(-1)?.amount).toBeGreaterThan(0n);
  });

  it('rounds the monthly interest half to even', () => {
    expect(installmentInterest(1_000n, 1800)).toBe(15n);
    expect(installmentInterest(50n, 1800)).toBe(1n);
  });

  it('always amortizes exactly, for any plan', () => {
    for (const principal of [5_000n, 12_345n, 99_999n, 1_000_001n]) {
      for (const months of [2, 3, 6, 12, 24, 60]) {
        for (const apr of [0, 1, 1800, 2400, 9900]) {
          const schedule = buildSchedule(principal, months, apr);
          expect(schedule).toHaveLength(months);
          expect(schedule.reduce((sum, b) => sum + b.principal, 0n)).toBe(
            principal,
          );
          expect(schedule.every((b) => b.principal > 0n)).toBe(true);
        }
      }
    }
  });
});
