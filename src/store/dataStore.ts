// In-memory key/value engine: strings, hashes, lists, sets, sorted sets.
//
// Values are tagged by type (`StoredEntry.type`) so an operation for one
// data type correctly rejects a key that holds a different type, matching
// real Redis's WRONGTYPE behavior.
//
// Expiry: every entry carries `expiresAt` (absolute unix-ms, or null for
// no expiry). Passive expiry is baked into every read path via
// `getLive()`, which lazily deletes an expired key the moment anything
// looks it up — so a key past its TTL behaves as if it doesn't exist even
// if nothing has actively cleaned it up yet. Active expiry (a periodic
// background sweep) is `sweepExpired()`, called on a timer by
// ExpiryEngine (src/expiry/expiryEngine.ts); it only ever checks a
// bounded number of keys-with-a-TTL per call, tracked separately in
// `keysWithExpiry`, so a sweep never has to scan the whole keyspace.
// Deliberately has no knowledge of RESP or the command dispatcher, so it
// can be reused/extended independently.

export interface StringEntry {
  type: 'string';
  value: string;
  /** Absolute unix-ms timestamp this key should expire at, or null for no expiry. */
  expiresAt: number | null;
}

export interface ListEntry {
  type: 'list';
  value: string[];
  expiresAt: number | null;
}

export interface HashEntry {
  type: 'hash';
  value: Map<string, string>;
  expiresAt: number | null;
}

export interface SetEntry {
  type: 'set';
  value: Set<string>;
  expiresAt: number | null;
}

export type StoredEntry = StringEntry | ListEntry | HashEntry | SetEntry;

/**
 * A key's entry in a JSON-serializable shape (Map/Set replaced with
 * plain arrays), used by Snapshot to dump/restore the whole store.
 */
export type SerializedEntry =
  | { key: string; type: 'string'; value: string; expiresAt: number | null }
  | { key: string; type: 'list'; value: string[]; expiresAt: number | null }
  | { key: string; type: 'hash'; value: Array<[string, string]>; expiresAt: number | null }
  | { key: string; type: 'set'; value: string[]; expiresAt: number | null };

/** Thrown when a command targets a key that currently holds a different data type. */
export class WrongTypeError extends Error {
  constructor() {
    super('WRONGTYPE Operation against a key holding the wrong kind of value');
    this.name = 'WrongTypeError';
  }
}

export class DataStore {
  private readonly data = new Map<string, StoredEntry>();
  /** Keys that currently have an expiry set — lets active expiry sample only these instead of the whole keyspace. */
  private readonly keysWithExpiry = new Set<string>();

  // ---- strings ----

  /** Sets a string key, optionally with an absolute expiry timestamp. Always overwrites, regardless of the key's prior type — matches real Redis SET. */
  set(key: string, value: string, expiresAt: number | null = null): void {
    this.data.set(key, { type: 'string', value, expiresAt });
    this.trackExpiry(key, expiresAt);
  }

  /** Returns the string value for `key`, or null if it doesn't exist (or has passively expired). Throws WrongTypeError if `key` holds a non-string value. */
  get(key: string): string | null {
    const entry = this.getLive(key);
    if (entry === undefined) return null;
    if (entry.type !== 'string') throw new WrongTypeError();
    return entry.value;
  }

  // ---- generic key operations (type-agnostic) ----

  /** Deletes each of `keys`, regardless of the value type they hold. Returns how many actually existed (an already-expired key doesn't count). */
  del(keys: string[]): number {
    let deleted = 0;
    for (const key of keys) {
      if (this.getLive(key) !== undefined) {
        this.deleteKey(key);
        deleted++;
      }
    }
    return deleted;
  }

  /** Returns how many of `keys` currently exist (a key repeated in the input counts each time; an expired key doesn't count). */
  exists(keys: string[]): number {
    let count = 0;
    for (const key of keys) {
      if (this.getLive(key) !== undefined) count++;
    }
    return count;
  }

  // ---- expiry (generic — works on a key of any type) ----

  /** Sets an absolute expiry timestamp (unix-ms) on `key`. Returns whether the key exists. */
  expireAt(key: string, expiresAtMs: number): boolean {
    const entry = this.getLive(key);
    if (entry === undefined) return false;
    entry.expiresAt = expiresAtMs;
    this.trackExpiry(key, expiresAtMs);
    return true;
  }

  /** Removes any expiry from `key`, making it persist forever. Returns whether it existed and had an expiry to remove. */
  persist(key: string): boolean {
    const entry = this.getLive(key);
    if (entry === undefined || entry.expiresAt === null) return false;
    entry.expiresAt = null;
    this.trackExpiry(key, null);
    return true;
  }

  /**
   * Remaining time-to-live in milliseconds: -2 if `key` doesn't exist
   * (including a key that has just passively expired), -1 if it exists
   * but has no expiry, otherwise the remaining ms (>= 0).
   */
  pttl(key: string): number {
    const entry = this.getLive(key);
    if (entry === undefined) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.max(entry.expiresAt - Date.now(), 0);
  }

  /**
   * Active-expiry sweep: checks up to `sampleSize` keys that currently
   * have an expiry set and deletes any that have passed it. Bounded work
   * per call by design — this is what ExpiryEngine calls on a timer
   * instead of scanning the whole keyspace synchronously, mirroring (a
   * simplified version of) real Redis's active expire cycle. Samples in
   * insertion order rather than true randomness, favoring determinism
   * over exactly matching Redis's algorithm. Returns how many keys were
   * removed.
   */
  sweepExpired(sampleSize: number): number {
    const now = Date.now();
    let sampled = 0;
    let removed = 0;

    for (const key of this.keysWithExpiry) {
      if (sampled >= sampleSize) break;
      sampled++;

      const entry = this.data.get(key);
      if (entry !== undefined && entry.expiresAt !== null && entry.expiresAt <= now) {
        this.deleteKey(key);
        removed++;
      }
    }

    return removed;
  }

  // ---- lists ----

  /** Pushes `values` onto the head of the list at `key`, one at a time (so the last value ends up first). Creates the list if `key` doesn't exist. Returns the new length. */
  lpush(key: string, values: string[]): number {
    const list = this.getOrCreateList(key);
    for (const value of values) {
      list.value.unshift(value);
    }
    return list.value.length;
  }

  /** Pushes `values` onto the tail of the list at `key`, in order. Creates the list if `key` doesn't exist. Returns the new length. */
  rpush(key: string, values: string[]): number {
    const list = this.getOrCreateList(key);
    list.value.push(...values);
    return list.value.length;
  }

  /** Removes and returns the first element of the list at `key`, or null if it doesn't exist or is empty. Removes the key entirely once its list empties. */
  lpop(key: string): string | null {
    return this.popFrom(key, 'head');
  }

  /** Removes and returns the last element of the list at `key`, or null if it doesn't exist or is empty. Removes the key entirely once its list empties. */
  rpop(key: string): string | null {
    return this.popFrom(key, 'tail');
  }

  /**
   * Returns the elements of the list at `key` from `start` to `stop`,
   * inclusive, 0-based, with negative indices counting from the end
   * (-1 is the last element) — matching real Redis LRANGE semantics.
   * Returns an empty array if `key` doesn't exist or the range is empty.
   */
  lrange(key: string, start: number, stop: number): string[] {
    const entry = this.getLive(key);
    if (entry === undefined) return [];
    if (entry.type !== 'list') throw new WrongTypeError();

    const length = entry.value.length;
    if (length === 0) return [];

    const from = Math.max(normalizeIndex(start, length), 0);
    const to = Math.min(normalizeIndex(stop, length), length - 1);
    if (from > to) return [];

    return entry.value.slice(from, to + 1);
  }

  /** Returns the length of the list at `key`, or 0 if it doesn't exist. */
  llen(key: string): number {
    const entry = this.getLive(key);
    if (entry === undefined) return 0;
    if (entry.type !== 'list') throw new WrongTypeError();
    return entry.value.length;
  }

  // ---- hashes ----

  /** Sets each field=value pair on the hash at `key`. Creates the hash if `key` doesn't exist. Returns how many fields were newly added (not updated). */
  hset(key: string, fields: Array<[string, string]>): number {
    const hash = this.getOrCreateHash(key);
    let added = 0;
    for (const [field, value] of fields) {
      if (!hash.value.has(field)) added++;
      hash.value.set(field, value);
    }
    return added;
  }

  /** Returns the value of `field` in the hash at `key`, or null if the hash or field doesn't exist. */
  hget(key: string, field: string): string | null {
    const entry = this.getLive(key);
    if (entry === undefined) return null;
    if (entry.type !== 'hash') throw new WrongTypeError();
    return entry.value.get(field) ?? null;
  }

  /** Deletes each of `fields` from the hash at `key`. Returns how many actually existed. Removes the key entirely once its hash empties. */
  hdel(key: string, fields: string[]): number {
    const entry = this.getLive(key);
    if (entry === undefined) return 0;
    if (entry.type !== 'hash') throw new WrongTypeError();

    let deleted = 0;
    for (const field of fields) {
      if (entry.value.delete(field)) deleted++;
    }
    if (entry.value.size === 0) {
      this.deleteKey(key);
    }
    return deleted;
  }

  /** Returns all [field, value] pairs in the hash at `key`, or an empty array if it doesn't exist. */
  hgetall(key: string): Array<[string, string]> {
    const entry = this.getLive(key);
    if (entry === undefined) return [];
    if (entry.type !== 'hash') throw new WrongTypeError();
    return [...entry.value.entries()];
  }

  /** Returns whether `field` exists in the hash at `key`. */
  hexists(key: string, field: string): boolean {
    const entry = this.getLive(key);
    if (entry === undefined) return false;
    if (entry.type !== 'hash') throw new WrongTypeError();
    return entry.value.has(field);
  }

  /** Returns the number of fields in the hash at `key`, or 0 if it doesn't exist. */
  hlen(key: string): number {
    const entry = this.getLive(key);
    if (entry === undefined) return 0;
    if (entry.type !== 'hash') throw new WrongTypeError();
    return entry.value.size;
  }

  // ---- sets ----

  /** Adds each of `members` to the set at `key`. Creates the set if `key` doesn't exist. Returns how many members were newly added (not already present). */
  sadd(key: string, members: string[]): number {
    const set = this.getOrCreateSet(key);
    let added = 0;
    for (const member of members) {
      if (!set.value.has(member)) added++;
      set.value.add(member);
    }
    return added;
  }

  /** Removes each of `members` from the set at `key`. Returns how many actually existed. Removes the key entirely once its set empties. */
  srem(key: string, members: string[]): number {
    const entry = this.getLive(key);
    if (entry === undefined) return 0;
    if (entry.type !== 'set') throw new WrongTypeError();

    let removed = 0;
    for (const member of members) {
      if (entry.value.delete(member)) removed++;
    }
    if (entry.value.size === 0) {
      this.deleteKey(key);
    }
    return removed;
  }

  /** Returns all members of the set at `key`, or an empty array if it doesn't exist. */
  smembers(key: string): string[] {
    const entry = this.getLive(key);
    if (entry === undefined) return [];
    if (entry.type !== 'set') throw new WrongTypeError();
    return [...entry.value];
  }

  /** Returns whether `member` is in the set at `key`. */
  sismember(key: string, member: string): boolean {
    const entry = this.getLive(key);
    if (entry === undefined) return false;
    if (entry.type !== 'set') throw new WrongTypeError();
    return entry.value.has(member);
  }

  /** Returns the number of members in the set at `key`, or 0 if it doesn't exist. */
  scard(key: string): number {
    const entry = this.getLive(key);
    if (entry === undefined) return 0;
    if (entry.type !== 'set') throw new WrongTypeError();
    return entry.value.size;
  }

  // ---- snapshotting ----

  /**
   * Returns every currently-live key's entry in a JSON-serializable
   * shape, for Snapshot to write to disk. Skips keys that have already
   * passed their TTL (best-effort — passive expiry cleans up anything
   * missed here once the snapshot is reloaded and the key is touched).
   */
  dumpAll(): SerializedEntry[] {
    const now = Date.now();
    const result: SerializedEntry[] = [];

    for (const [key, entry] of this.data) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) continue;

      switch (entry.type) {
        case 'string':
          result.push({ key, type: 'string', value: entry.value, expiresAt: entry.expiresAt });
          break;
        case 'list':
          result.push({ key, type: 'list', value: [...entry.value], expiresAt: entry.expiresAt });
          break;
        case 'hash':
          result.push({
            key,
            type: 'hash',
            value: [...entry.value.entries()],
            expiresAt: entry.expiresAt,
          });
          break;
        case 'set':
          result.push({ key, type: 'set', value: [...entry.value], expiresAt: entry.expiresAt });
          break;
      }
    }

    return result;
  }

  /** Restores entries produced by a prior dumpAll(), overwriting any current entry for the same key. Used when loading a snapshot at startup. */
  restoreAll(entries: SerializedEntry[]): void {
    for (const entry of entries) {
      switch (entry.type) {
        case 'string':
          this.data.set(entry.key, {
            type: 'string',
            value: entry.value,
            expiresAt: entry.expiresAt,
          });
          break;
        case 'list':
          this.data.set(entry.key, {
            type: 'list',
            value: [...entry.value],
            expiresAt: entry.expiresAt,
          });
          break;
        case 'hash':
          this.data.set(entry.key, {
            type: 'hash',
            value: new Map(entry.value),
            expiresAt: entry.expiresAt,
          });
          break;
        case 'set':
          this.data.set(entry.key, {
            type: 'set',
            value: new Set(entry.value),
            expiresAt: entry.expiresAt,
          });
          break;
      }
      this.trackExpiry(entry.key, entry.expiresAt);
    }
  }

  // ---- shared internals ----

  private getOrCreateSet(key: string): SetEntry {
    const entry = this.getLive(key);
    if (entry === undefined) {
      const set: SetEntry = { type: 'set', value: new Set(), expiresAt: null };
      this.data.set(key, set);
      return set;
    }
    if (entry.type !== 'set') throw new WrongTypeError();
    return entry;
  }

  private getOrCreateHash(key: string): HashEntry {
    const entry = this.getLive(key);
    if (entry === undefined) {
      const hash: HashEntry = { type: 'hash', value: new Map(), expiresAt: null };
      this.data.set(key, hash);
      return hash;
    }
    if (entry.type !== 'hash') throw new WrongTypeError();
    return entry;
  }

  private getOrCreateList(key: string): ListEntry {
    const entry = this.getLive(key);
    if (entry === undefined) {
      const list: ListEntry = { type: 'list', value: [], expiresAt: null };
      this.data.set(key, list);
      return list;
    }
    if (entry.type !== 'list') throw new WrongTypeError();
    return entry;
  }

  private popFrom(key: string, end: 'head' | 'tail'): string | null {
    const entry = this.getLive(key);
    if (entry === undefined) return null;
    if (entry.type !== 'list') throw new WrongTypeError();

    const popped = end === 'head' ? entry.value.shift() : entry.value.pop();
    if (popped === undefined) return null;

    if (entry.value.length === 0) {
      this.deleteKey(key);
    }
    return popped;
  }

  /**
   * Looks up `key`, lazily deleting it and reporting it as absent if its
   * TTL has already passed. Every read path (and every getOrCreate*)
   * goes through this, which is what makes passive expiry work without
   * any background process — a key past its TTL is correctly invisible
   * on the very next access, whether or not the active sweep has ever
   * run.
   */
  private getLive(key: string): StoredEntry | undefined {
    const entry = this.data.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.deleteKey(key);
      return undefined;
    }
    return entry;
  }

  /** Deletes `key` from both the main map and the expiry-tracking set. Returns whether it existed. */
  private deleteKey(key: string): boolean {
    this.keysWithExpiry.delete(key);
    return this.data.delete(key);
  }

  /** Keeps `keysWithExpiry` in sync after a key's expiresAt is set or cleared. */
  private trackExpiry(key: string, expiresAt: number | null): void {
    if (expiresAt === null) {
      this.keysWithExpiry.delete(key);
    } else {
      this.keysWithExpiry.add(key);
    }
  }

  /** Raw entry access (value + type + expiry metadata), for modules that need more than the plain value. Respects passive expiry. */
  getEntry(key: string): StoredEntry | undefined {
    return this.getLive(key);
  }

  /** Number of keys currently stored. */
  get size(): number {
    return this.data.size;
  }
}

function normalizeIndex(index: number, length: number): number {
  return index < 0 ? length + index : index;
}
