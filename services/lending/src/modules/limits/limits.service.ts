import { Inject, Injectable } from '@nestjs/common';
import { Cache } from '@acme/cache';
import type { CustodyLimitResponse } from '@acme/contracts';
import {
  Clock,
  NotFoundError,
  ServiceUnavailableError,
  toMinor,
} from '@acme/nest-common';
import {
  CustodyClient,
  CustodyRejectedError,
  CustodyUnavailableError,
} from '../../clients/custody/custody.client.js';
import { LIMITS_CONFIG, type LimitsConfig } from './limits.config.js';

interface CachedLimit {
  cupo: string;
  fetchedAt: number;
}

export class LimitUnavailableError extends ServiceUnavailableError {
  constructor() {
    super(
      'LIMIT_UNAVAILABLE',
      'The credit limit cannot be determined right now',
    );
  }
}

@Injectable()
export class LimitsService {
  constructor(
    private readonly cache: Cache,
    private readonly custody: CustodyClient,
    private readonly clock: Clock,
    @Inject(LIMITS_CONFIG) private readonly config: LimitsConfig,
  ) {}

  async getCupo(custodyAccountId: string): Promise<bigint> {
    const key = this.key(custodyAccountId);
    const entry = await this.cache.get(key);
    const cached = entry ? (JSON.parse(entry.value) as CachedLimit) : undefined;
    const now = this.clock.now().getTime();

    if (cached && now < cached.fetchedAt + this.config.ttlSeconds * 1000)
      return BigInt(cached.cupo);

    try {
      return (await this.refresh(custodyAccountId)).cupo;
    } catch (error) {
      if (error instanceof CustodyRejectedError)
        throw new NotFoundError(
          'CUSTODY_ACCOUNT_NOT_FOUND',
          'Custody account not found',
        );
      if (!(error instanceof CustodyUnavailableError)) throw error;
      const staleUntil = cached
        ? cached.fetchedAt +
          (this.config.ttlSeconds + this.config.staleMaxAgeSeconds) * 1000
        : 0;
      if (cached && this.config.policy === 'use_stale' && now < staleUntil)
        return BigInt(cached.cupo);
      throw new LimitUnavailableError();
    }
  }

  async refresh(
    custodyAccountId: string,
  ): Promise<{ cupo: bigint; version: number }> {
    const limit = await this.custody.getLimit(custodyAccountId);
    await this.store(limit);
    return { cupo: toMinor(limit.cupo), version: limit.version };
  }

  async store(limit: CustodyLimitResponse): Promise<void> {
    const value: CachedLimit = {
      cupo: String(limit.cupo),
      fetchedAt: this.clock.now().getTime(),
    };
    const ttl = this.config.ttlSeconds + this.config.staleMaxAgeSeconds;
    await this.cache.setIfNotOlder(
      this.key(limit.custodyAccountId),
      { version: limit.version, value: JSON.stringify(value) },
      ttl,
    );
  }

  async applyVersion(custodyAccountId: string, version: number): Promise<void> {
    const entry = await this.cache.get(this.key(custodyAccountId));
    if (entry && entry.version >= version) return;
    await this.refresh(custodyAccountId);
  }

  private key(custodyAccountId: string): string {
    return `limit:${custodyAccountId}`;
  }
}
