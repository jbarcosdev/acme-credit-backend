import type { Redis } from 'ioredis';
import { Cache, type VersionedEntry } from './cache.js';

const SET_IF_NEWER = `
local current = redis.call('HGET', KEYS[1], 'version')
if current and tonumber(current) > tonumber(ARGV[1]) then
  return 0
end
redis.call('HSET', KEYS[1], 'version', ARGV[1], 'value', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
`;

export class RedisCache extends Cache {
  constructor(private readonly redis: Redis) {
    super();
  }

  async get(key: string): Promise<VersionedEntry | null> {
    const stored = await this.redis.hgetall(key);
    if (!stored.version) return null;
    return { version: Number(stored.version), value: stored.value };
  }

  async setIfNotOlder(
    key: string,
    entry: VersionedEntry,
    ttlSeconds: number,
  ): Promise<boolean> {
    const result = await this.redis.eval(
      SET_IF_NEWER,
      1,
      key,
      String(entry.version),
      entry.value,
      String(ttlSeconds),
    );
    return result === 1;
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
