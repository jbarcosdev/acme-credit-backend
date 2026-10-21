import { Redis } from 'ioredis';
import { InMemoryCache } from './in-memory-cache.js';
import { RedisCache } from './redis-cache.js';
import type { Cache } from './cache.js';

function contract(
  name: string,
  create: () => Promise<{
    cache: Cache;
    key: string;
    done?: () => Promise<void>;
  }>,
) {
  describe(name, () => {
    it('stores a value and ignores older or equal versions', async () => {
      const { cache, key, done } = await create();
      expect(await cache.setIfNewer(key, { version: 2, value: 'a' }, 60)).toBe(
        true,
      );
      expect(await cache.setIfNewer(key, { version: 1, value: 'b' }, 60)).toBe(
        false,
      );
      expect(await cache.setIfNewer(key, { version: 2, value: 'c' }, 60)).toBe(
        false,
      );
      expect(await cache.get(key)).toEqual({ version: 2, value: 'a' });
      expect(await cache.setIfNewer(key, { version: 3, value: 'd' }, 60)).toBe(
        true,
      );
      expect(await cache.get(key)).toEqual({ version: 3, value: 'd' });
      await cache.delete(key);
      expect(await cache.get(key)).toBeNull();
      await done?.();
    });
  });
}

contract('InMemoryCache', async () => ({
  cache: new InMemoryCache(),
  key: 'k',
}));

contract('RedisCache', async () => {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return {
    cache: new RedisCache(redis),
    key: `test:${crypto.randomUUID()}`,
    done: async () => void (await redis.quit()),
  };
});

describe('InMemoryCache expiry', () => {
  it('drops entries after the ttl', async () => {
    let now = 1_000;
    const cache = new InMemoryCache(() => now);
    await cache.setIfNewer('k', { version: 1, value: 'a' }, 10);
    now += 9_000;
    expect(await cache.get('k')).not.toBeNull();
    now += 2_000;
    expect(await cache.get('k')).toBeNull();
  });
});
