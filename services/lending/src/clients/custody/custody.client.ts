import type {
  CustodyLimitResponse,
  LimitReductionResponse,
  SettlementResponse,
} from '@acme/contracts';
import { ServiceTokenProvider } from '@acme/auth';
import { SCOPES } from '@acme/contracts';

export class CustodyUnavailableError extends Error {}

export class CustodyRejectedError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export abstract class CustodyClient {
  abstract getLimit(custodyAccountId: string): Promise<CustodyLimitResponse>;
  abstract settle(
    custodyAccountId: string,
    key: string,
    applyAmount: number,
  ): Promise<SettlementResponse>;
  abstract reduceLimit(
    custodyAccountId: string,
    key: string,
    newCupo: number,
  ): Promise<LimitReductionResponse>;
}

export interface HttpCustodyClientOptions {
  baseUrl: string;
  timeoutMs: number;
}

export class HttpCustodyClient extends CustodyClient {
  constructor(
    private readonly tokens: ServiceTokenProvider,
    private readonly options: HttpCustodyClientOptions,
  ) {
    super();
  }

  getLimit(id: string): Promise<CustodyLimitResponse> {
    return this.request('GET', `/custody-accounts/${id}/limit`, [
      SCOPES.custodyRead,
    ]);
  }

  settle(
    id: string,
    key: string,
    applyAmount: number,
  ): Promise<SettlementResponse> {
    return this.request(
      'POST',
      `/custody-accounts/${id}/settlements`,
      [SCOPES.custodySettle],
      { applyAmount },
      key,
    );
  }

  reduceLimit(
    id: string,
    key: string,
    newCupo: number,
  ): Promise<LimitReductionResponse> {
    return this.request(
      'POST',
      `/custody-accounts/${id}/limit-reductions`,
      [SCOPES.custodySettle],
      { newCupo },
      key,
    );
  }

  private async request<T>(
    method: string,
    path: string,
    scopes: string[],
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${await this.tokens.getToken(scopes)}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch {
      throw new CustodyUnavailableError('custody service unreachable');
    }
    if (response.status >= 500)
      throw new CustodyUnavailableError(
        `custody service error ${response.status}`,
      );
    const payload = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok) {
      throw new CustodyRejectedError(
        response.status,
        String(payload.code ?? 'CUSTODY_ERROR'),
        String(payload.message ?? 'custody rejected the request'),
      );
    }
    return payload as T;
  }
}
