import { divRoundHalfEven } from './rounding.js';

const MONTHLY_DENOMINATOR = 120_000n;

export interface InstallmentBill {
  number: number;
  principal: bigint;
  interest: bigint;
  amount: bigint;
}

export interface PlanState {
  installments: number;
  aprBps: number;
  installmentAmount: bigint;
  remainingPrincipal: bigint;
  billedCount: number;
}

export function installmentInterest(remaining: bigint, aprBps: number): bigint {
  return divRoundHalfEven(remaining * BigInt(aprBps), MONTHLY_DENOMINATOR);
}

export function annuityPayment(
  principal: bigint,
  installments: number,
  aprBps: number,
): bigint {
  if (aprBps === 0) return divRoundHalfEven(principal, BigInt(installments));
  const growth = MONTHLY_DENOMINATOR + BigInt(aprBps);
  const growthN = growth ** BigInt(installments);
  const baseN = MONTHLY_DENOMINATOR ** BigInt(installments);
  return divRoundHalfEven(
    principal * BigInt(aprBps) * growthN,
    MONTHLY_DENOMINATOR * (growthN - baseN),
  );
}

export function nextInstallment(plan: PlanState): InstallmentBill {
  const number = plan.billedCount + 1;
  const interest = installmentInterest(plan.remainingPrincipal, plan.aprBps);
  const isLast = number === plan.installments;
  let principal = isLast
    ? plan.remainingPrincipal
    : plan.installmentAmount - interest;
  if (principal > plan.remainingPrincipal) principal = plan.remainingPrincipal;
  if (principal < 0n) principal = 0n;
  return { number, principal, interest, amount: principal + interest };
}

export function buildSchedule(
  principal: bigint,
  installments: number,
  aprBps: number,
): InstallmentBill[] {
  const state: PlanState = {
    installments,
    aprBps,
    installmentAmount: annuityPayment(principal, installments, aprBps),
    remainingPrincipal: principal,
    billedCount: 0,
  };
  const bills: InstallmentBill[] = [];
  while (state.billedCount < installments) {
    const bill = nextInstallment(state);
    bills.push(bill);
    state.remainingPrincipal -= bill.principal;
    state.billedCount += 1;
  }
  return bills;
}
