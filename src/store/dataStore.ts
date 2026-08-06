// In-memory key/value engine: strings, hashes, lists, sets, sorted sets.
//
// Values are tagged by type (`StoredEntry.type`) so an operation for one
// data type correctly rejects a key that holds a different type, matching
// real Redis's WRONGTYPE behavior. `expiresAt` is recorded by SET (EX/PX)
// but not yet enforced anywhere — the expiry engine that reads and acts on
// it is a later chunk. Deliberately has no knowledge of RESP or the
// command dispatcher, so it can be reused/extended independently.

export interface StringEntry {
  type: 'string';
  value: string;
  /** Absolute unix-ms timestamp this key should expire at, or null for no expiry. Not yet enforced. */
  expiresAt: number | null;
}

export interface ListEntry {
  type: 'list';
  value: string[];
  expiresAt: number | null;
}

export type StoredEntry = StringEntry | ListEntry;

/** Thrown when a command targets a key that currently holds a different data type. */
export class WrongTypeError extends Error {
  constructor() {
    super('WRONGTYPE Operation against a key holding the wrong kind of value');
    this.name = 'WrongTypeError';
  }
}

export class DataStore {
  private readonly data = new Map<string, StoredEntry>();

  // ---- strings ----

  /** Sets a string key, optionally with an absolute expiry timestamp. Always overwrites, regardless of the key's prior type — matches real Redis SET. */
  set(key: string, value: string, expiresAt: number | null = null): void {
    this.data.set(key, { type: 'string', value, expiresAt });
  }

  /** Returns the string value for `key`, or null if it doesn't exist. Throws WrongTypeError if `key` holds a non-string value. */
  get(key: string): string | null {
    const entry = this.data.get(key);
    if (entry === undefined) return null;
    if (entry.type !== 'string') throw new WrongTypeError();
    return entry.value;
  }

  // ---- generic key operations (type-agnostic) ----

  /** Deletes each of `keys`, regardless of the value type they hold. Returns how many actually existed. */
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
    const entry = this.data.get(key);
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
    const entry = this.data.get(key);
    if (entry === undefined) return 0;
    if (entry.type !== 'list') throw new WrongTypeError();
    return entry.value.length;
  }

  // ---- shared internals ----

  private getOrCreateList(key: string): ListEntry {
    const entry = this.data.get(key);
    if (entry === undefined) {
      const list: ListEntry = { type: 'list', value: [], expiresAt: null };
      this.data.set(key, list);
      return list;
    }
    if (entry.type !== 'list') throw new WrongTypeError();
    return entry;
  }

  private popFrom(key: string, end: 'head' | 'tail'): string | null {
    const entry = this.data.get(key);
    if (entry === undefined) return null;
    if (entry.type !== 'list') throw new WrongTypeError();

    const popped = end === 'head' ? entry.value.shift() : entry.value.pop();
    if (popped === undefined) return null;

    if (entry.value.length === 0) {
      this.data.delete(key);
    }
    return popped;
  }

  /** Raw entry access (value + type + expiry metadata), for modules that need more than the plain value. */
  getEntry(key: string): StoredEntry | undefined {
    return this.data.get(key);
  }

  /** Number of keys currently stored. */
  get size(): number {
    return this.data.size;
  }
}

function normalizeIndex(index: number, length: number): number {
  return index < 0 ? length + index : index;
}
