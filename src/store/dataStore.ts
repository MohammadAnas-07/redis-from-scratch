// In-memory key/value engine: strings, hashes, lists, sets, sorted sets.
//
// This chunk only needs string values. `expiresAt` is recorded on SET (for
// EX/PX) but is not yet enforced anywhere — the expiry engine that reads
// and acts on it is a later chunk. Deliberately has no knowledge of RESP or
// the command dispatcher, so it can be reused/extended independently.

export interface StoredEntry {
  value: string;
  /** Absolute unix-ms timestamp this key should expire at, or null for no expiry. Not yet enforced. */
  expiresAt: number | null;
}

export class DataStore {
  private readonly data = new Map<string, StoredEntry>();

  /** Sets a string key, optionally with an absolute expiry timestamp. */
  set(key: string, value: string, expiresAt: number | null = null): void {
    this.data.set(key, { value, expiresAt });
  }

  /** Returns the string value for `key`, or null if it doesn't exist. */
  get(key: string): string | null {
    return this.data.get(key)?.value ?? null;
  }

  /** Deletes each of `keys`. Returns how many actually existed and were removed. */
  del(keys: string[]): number {
    let deleted = 0;
    for (const key of keys) {
      if (this.data.delete(key)) deleted++;
    }
    return deleted;
  }

  /** Returns how many of `keys` currently exist (a key repeated in the input counts each time). */
  exists(keys: string[]): number {
    let count = 0;
    for (const key of keys) {
      if (this.data.has(key)) count++;
    }
    return count;
  }

  /** Raw entry access (value + expiry metadata), for modules that need more than the plain value. */
  getEntry(key: string): StoredEntry | undefined {
    return this.data.get(key);
  }

  /** Number of keys currently stored. */
  get size(): number {
    return this.data.size;
  }
}
