export interface LendingTerms {
  version: number;
  aprBps: number;
  lateFeeAmount: bigint;
  minPaymentBps: number;
  minPaymentFloor: bigint;
  chargeOffDays: number;
  dueDays: number;
  cycleDays: number[];
}

export abstract class LendingTermsProvider {
  abstract getCurrent(): Promise<LendingTerms>;
  abstract getVersion(version: number): Promise<LendingTerms>;
}

export class StaticLendingTermsProvider extends LendingTermsProvider {
  constructor(private readonly terms: LendingTerms) {
    super();
  }

  async getCurrent(): Promise<LendingTerms> {
    return this.terms;
  }

  async getVersion(): Promise<LendingTerms> {
    return this.terms;
  }
}

export function defaultLendingTerms(
  env: NodeJS.ProcessEnv = process.env,
): LendingTerms {
  return {
    version: 1,
    aprBps: Number(env.TERMS_APR_BPS ?? 3600),
    lateFeeAmount: BigInt(env.TERMS_LATE_FEE ?? 1500),
    minPaymentBps: Number(env.TERMS_MIN_PAYMENT_BPS ?? 500),
    minPaymentFloor: BigInt(env.TERMS_MIN_PAYMENT_FLOOR ?? 2500),
    chargeOffDays: Number(env.TERMS_CHARGE_OFF_DAYS ?? 90),
    dueDays: Number(env.TERMS_DUE_DAYS ?? 20),
    cycleDays: [1, 15],
  };
}
