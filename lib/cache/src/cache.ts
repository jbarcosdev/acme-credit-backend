export interface VersionedEntry {
  version: number;
  value: string;
}

export abstract class Cache {
  abstract get(key: string): Promise<VersionedEntry | null>;
  abstract setIfNewer(
    key: string,
    entry: VersionedEntry,
    ttlSeconds: number,
  ): Promise<boolean>;
  abstract delete(key: string): Promise<void>;
}
