import { Cache, type VersionedEntry } from './cache.js';

interface StoredEntry extends VersionedEntry {
  expiresAt: number;
}

export class InMemoryCache extends Cache {
  private readonly store = new Map<string, StoredEntry>();

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  async get(key: string): Promise<VersionedEntry | null> {
    const stored = this.store.get(key);
    if (!stored) return null;
    if (stored.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return { version: stored.version, value: stored.value };
  }

  async setIfNotOlder(
    key: string,
    entry: VersionedEntry,
    ttlSeconds: number,
  ): Promise<boolean> {
    const current = await this.get(key);
    if (current && current.version > entry.version) return false;
    this.store.set(key, {
      ...entry,
      expiresAt: this.now() + ttlSeconds * 1000,
    });
    return true;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
