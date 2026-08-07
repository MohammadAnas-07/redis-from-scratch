import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AofLog } from '../../../src/persistence/aof.js';
import { loadPersistedState, Snapshot } from '../../../src/persistence/snapshot.js';
import { type RespValue } from '../../../src/protocol/respTypes.js';
import { DataStore } from '../../../src/store/dataStore.js';

describe('Snapshot', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'snapshot-test-'));
    filePath = join(dir, 'dump.snapshot');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('save / load round-trip', () => {
    it('round-trips a string value', () => {
      const store = new DataStore();
      store.set('foo', 'bar');

      new Snapshot(filePath).save(store);
      const restored = new DataStore();
      new Snapshot(filePath).load(restored);

      expect(restored.get('foo')).toBe('bar');
    });

    it('round-trips a list, preserving order', () => {
      const store = new DataStore();
      store.rpush('mylist', ['a', 'b', 'c']);

      new Snapshot(filePath).save(store);
      const restored = new DataStore();
      new Snapshot(filePath).load(restored);

      expect(restored.lrange('mylist', 0, -1)).toEqual(['a', 'b', 'c']);
    });

    it('round-trips a hash', () => {
      const store = new DataStore();
      store.hset('myhash', [
        ['field1', 'a'],
        ['field2', 'b'],
      ]);

      new Snapshot(filePath).save(store);
      const restored = new DataStore();
      new Snapshot(filePath).load(restored);

      expect(restored.hgetall('myhash')).toEqual([
        ['field1', 'a'],
        ['field2', 'b'],
      ]);
    });

    it('round-trips a set', () => {
      const store = new DataStore();
      store.sadd('myset', ['a', 'b']);

      new Snapshot(filePath).save(store);
      const restored = new DataStore();
      new Snapshot(filePath).load(restored);

      expect(restored.smembers('myset').sort()).toEqual(['a', 'b']);
    });

    it('round-trips an expiry timestamp', () => {
      const store = new DataStore();
      const expiresAt = Date.now() + 60_000;
      store.set('foo', 'bar', expiresAt);

      new Snapshot(filePath).save(store);
      const restored = new DataStore();
      new Snapshot(filePath).load(restored);

      expect(restored.getEntry('foo')?.expiresAt).toBe(expiresAt);
    });

    it('round-trips a key with no expiry as null', () => {
      const store = new DataStore();
      store.set('foo', 'bar');

      new Snapshot(filePath).save(store);
      const restored = new DataStore();
      new Snapshot(filePath).load(restored);

      expect(restored.getEntry('foo')?.expiresAt).toBeNull();
    });

    it('round-trips a mixed dataset across all four types', () => {
      const store = new DataStore();
      store.set('str', 'value');
      store.rpush('list', ['x', 'y']);
      store.hset('hash', [['f', 'v']]);
      store.sadd('set', ['m']);

      new Snapshot(filePath).save(store);
      const restored = new DataStore();
      new Snapshot(filePath).load(restored);

      expect(restored.size).toBe(4);
      expect(restored.get('str')).toBe('value');
      expect(restored.lrange('list', 0, -1)).toEqual(['x', 'y']);
      expect(restored.hgetall('hash')).toEqual([['f', 'v']]);
      expect(restored.smembers('set')).toEqual(['m']);
    });

    it('skips an already-expired key rather than persisting it', () => {
      const store = new DataStore();
      // Directly craft an already-past expiry via expireAt, bypassing SET's
      // validation (which rejects non-positive amounts) — dumpAll() should
      // still filter it out regardless of how it got there.
      store.set('foo', 'bar');
      store.expireAt('foo', Date.now() - 1000);

      new Snapshot(filePath).save(store);
      const restored = new DataStore();
      new Snapshot(filePath).load(restored);

      expect(restored.size).toBe(0);
    });

    it('creates the parent directory if it does not exist yet', () => {
      const nestedPath = join(dir, 'nested', 'deep', 'dump.snapshot');
      const store = new DataStore();
      store.set('foo', 'bar');

      expect(() => new Snapshot(nestedPath).save(store)).not.toThrow();

      const restored = new DataStore();
      new Snapshot(nestedPath).load(restored);
      expect(restored.get('foo')).toBe('bar');
    });

    it('overwrites a previous snapshot rather than appending', () => {
      const store = new DataStore();
      store.set('foo', 'first');
      const snapshot = new Snapshot(filePath);
      snapshot.save(store);

      store.set('foo', 'second');
      snapshot.save(store);

      const restored = new DataStore();
      snapshot.load(restored);
      expect(restored.get('foo')).toBe('second');
    });
  });

  describe('load edge cases', () => {
    it('returns false and does not throw when the file does not exist', () => {
      const store = new DataStore();
      expect(new Snapshot(filePath).load(store)).toBe(false);
    });

    it('returns false and does not throw on a corrupted (non-JSON) file', () => {
      writeFileSync(filePath, 'this is not json at all {{{');
      const store = new DataStore();

      expect(() => new Snapshot(filePath).load(store)).not.toThrow();
      expect(new Snapshot(filePath).load(store)).toBe(false);
    });

    it('logs a message when the file is corrupted', () => {
      writeFileSync(filePath, 'not json');
      const messages: string[] = [];
      new Snapshot(filePath, (m) => messages.push(m)).load(new DataStore());

      expect(messages.some((m) => /could not parse|corrupt/i.test(m))).toBe(true);
    });
  });

  describe('exists / mtimeMs', () => {
    it('exists() is false before a save and true after', () => {
      const snapshot = new Snapshot(filePath);
      expect(snapshot.exists()).toBe(false);
      snapshot.save(new DataStore());
      expect(snapshot.exists()).toBe(true);
    });

    it('mtimeMs() is null before a save and a number after', () => {
      const snapshot = new Snapshot(filePath);
      expect(snapshot.mtimeMs()).toBeNull();
      snapshot.save(new DataStore());
      expect(typeof snapshot.mtimeMs()).toBe('number');
    });
  });
});

describe('loadPersistedState (AOF-vs-snapshot precedence)', () => {
  let dir: string;
  let aofPath: string;
  let snapshotPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'precedence-test-'));
    aofPath = join(dir, 'appendonly.aof');
    snapshotPath = join(dir, 'dump.snapshot');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function setMtime(filePath: string, msSinceEpoch: number): void {
    const date = new Date(msSinceEpoch);
    utimesSync(filePath, date, date);
  }

  it('loads nothing when neither file exists', () => {
    const store = new DataStore();
    const snapshot = new Snapshot(snapshotPath);
    const aofLog = new AofLog(aofPath);
    const applied: RespValue[] = [];

    const source = loadPersistedState(store, snapshot, aofLog, (r) => applied.push(r));

    expect(source).toBe('none');
    expect(store.size).toBe(0);
    expect(applied).toEqual([]);
  });

  it('loads the snapshot when only the snapshot exists', () => {
    const seed = new DataStore();
    seed.set('foo', 'from-snapshot');
    new Snapshot(snapshotPath).save(seed);

    const store = new DataStore();
    const source = loadPersistedState(
      store,
      new Snapshot(snapshotPath),
      new AofLog(aofPath),
      () => {},
    );

    expect(source).toBe('snapshot');
    expect(store.get('foo')).toBe('from-snapshot');
  });

  it('replays the AOF when only the AOF exists', () => {
    const aofLog = new AofLog(aofPath);
    aofLog.append({
      type: 'array',
      value: [
        { type: 'bulk', value: 'SET' },
        { type: 'bulk', value: 'foo' },
        { type: 'bulk', value: 'from-aof' },
      ],
    });

    const store = new DataStore();
    const applied: RespValue[] = [];
    const source = loadPersistedState(store, new Snapshot(snapshotPath), aofLog, (r) =>
      applied.push(r),
    );

    expect(source).toBe('aof');
    expect(applied).toHaveLength(1);
  });

  it('prefers the AOF when it is newer than the snapshot', () => {
    new Snapshot(snapshotPath).save(new DataStore());
    setMtime(snapshotPath, 1_000_000);

    new AofLog(aofPath).append({ type: 'array', value: [{ type: 'bulk', value: 'PING' }] });
    setMtime(aofPath, 2_000_000); // newer than the snapshot

    const store = new DataStore();
    const applied: RespValue[] = [];
    const source = loadPersistedState(store, new Snapshot(snapshotPath), new AofLog(aofPath), (r) =>
      applied.push(r),
    );

    expect(source).toBe('aof');
    expect(applied).toHaveLength(1);
  });

  it('prefers the snapshot when the AOF is older', () => {
    new AofLog(aofPath).append({ type: 'array', value: [{ type: 'bulk', value: 'PING' }] });
    setMtime(aofPath, 1_000_000); // older

    const seed = new DataStore();
    seed.set('foo', 'from-snapshot');
    new Snapshot(snapshotPath).save(seed);
    setMtime(snapshotPath, 2_000_000); // newer than the AOF

    const store = new DataStore();
    const applied: RespValue[] = [];
    const source = loadPersistedState(store, new Snapshot(snapshotPath), new AofLog(aofPath), (r) =>
      applied.push(r),
    );

    expect(source).toBe('snapshot');
    expect(store.get('foo')).toBe('from-snapshot');
    expect(applied).toEqual([]); // AOF was not replayed
  });

  it('prefers the AOF on a tie (equal mtimes)', () => {
    new AofLog(aofPath).append({ type: 'array', value: [{ type: 'bulk', value: 'PING' }] });
    new Snapshot(snapshotPath).save(new DataStore());
    setMtime(aofPath, 1_500_000);
    setMtime(snapshotPath, 1_500_000);

    const store = new DataStore();
    const applied: RespValue[] = [];
    const source = loadPersistedState(store, new Snapshot(snapshotPath), new AofLog(aofPath), (r) =>
      applied.push(r),
    );

    expect(source).toBe('aof');
    expect(applied).toHaveLength(1);
  });
});
