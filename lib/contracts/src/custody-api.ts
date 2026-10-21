export interface CustodyLimitResponse {
  custodyAccountId: string;
  ownerId: string;
  currency: string;
  cupo: number;
  version: number;
}

export interface SettlementRequest {
  applyAmount: number;
}

export interface SettlementResponse {
  applied: number;
  released: number;
}

export interface LimitReductionRequest {
  newCupo: number;
}

export interface LimitReductionResponse {
  cupo: number;
  version: number;
  released: number;
}
