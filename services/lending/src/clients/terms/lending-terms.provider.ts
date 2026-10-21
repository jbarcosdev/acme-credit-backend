export interface InstallmentOption {
  months: number;
  aprBps: number;
}

export interface LendingTerms {
  version: number;
  aprBps: number;
  lateFeeAmount: bigint;
  minPaymentBps: number;
  minPaymentFloor: bigint;
  chargeOffDays: number;
  dueDays: number;
  cycleDays: number[];
  installmentOptions: InstallmentOption[];
  minInstallmentPurchase: bigint;
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
    installmentOptions: parseInstallmentOptions(
      env.TERMS_INSTALLMENT_OPTIONS ?? '3:0,6:1800,12:2400',
    ),
    minInstallmentPurchase: BigInt(env.TERMS_MIN_INSTALLMENT_PURCHASE ?? 5000),
  };
}

function parseInstallmentOptions(value: string): InstallmentOption[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [months, aprBps] = item.split(':').map(Number);
      return { months, aprBps };
    });
}
