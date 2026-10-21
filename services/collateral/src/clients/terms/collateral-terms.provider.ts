export interface CollateralTerms {
  ratioBps: number;
}

export abstract class CollateralTermsProvider {
  abstract getTerms(): Promise<CollateralTerms>;
}

export class StaticCollateralTermsProvider extends CollateralTermsProvider {
  constructor(private readonly terms: CollateralTerms) {
    super();
  }

  async getTerms(): Promise<CollateralTerms> {
    return this.terms;
  }
}
