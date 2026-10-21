export type LimitUnavailablePolicy = 'deny' | 'use_stale';

export interface LimitsConfig {
  ttlSeconds: number;
  staleMaxAgeSeconds: number;
  policy: LimitUnavailablePolicy;
}

export const LIMITS_CONFIG = 'LIMITS_CONFIG';

export function limitsConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LimitsConfig {
  return {
    ttlSeconds: Number(env.LIMIT_CACHE_TTL_SECONDS ?? 43200),
    staleMaxAgeSeconds: Number(env.LIMIT_STALE_MAX_AGE_SECONDS ?? 3600),
    policy: env.LIMIT_UNAVAILABLE_POLICY === 'use_stale' ? 'use_stale' : 'deny',
  };
}
