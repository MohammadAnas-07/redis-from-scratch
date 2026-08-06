import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataStore, WrongTypeError } from '../../../src/store/dataStore.js';

describe('DataStore', () => {
  it('returns null for a key that was never set', () => {
    const store = new DataStore();
    expect(store.get('missing')).toBeNull();
  });

  it('stores and retrieves a string value', () => {
    const store = new DataStore();
    store.set('foo', 'bar');
    expect(store.get('foo')).toBe('bar');
  });

  it('overwrites an existing value', () => {
    const store = new DataStore();
    store.set('foo', 'bar');
    store.set('foo', 'baz');
    expect(store.get('foo')).toBe('baz');
  });

  it('records an expiry timestamp without enforcing it in this chunk', () => {
    const store = new DataStore();
    const expiresAt = Date.now() + 1000;
    store.set('foo', 'bar', expiresAt);
    expect(store.get('foo')).toBe('bar'); // still readable — no enforcement yet
    expect(store.getEntry('foo')?.expiresAt).toBe(expiresAt);
  });

  it('defaults to no expiry when none is given', () => {
    const store = new DataStore();
    store.set('foo', 'bar');
    expect(store.getEntry('foo')?.expiresAt).toBeNull();
  });

  it('clears a previous expiry when overwritten without one', () => {
    const store = new DataStore();
    store.set('foo', 'bar', Date.now() + 1000);
    store.set('foo', 'baz');
    expect(store.getEntry('foo')?.expiresAt).toBeNull();
  });

  describe('del', () => {
    it('deletes an existing key and reports 1 removed', () => {
      const store = new DataStore();
      store.set('foo', 'bar');
      expect(store.del(['foo'])).toBe(1);
      expect(store.get('foo')).toBeNull();
    });

    it('reports 0 for a key that does not exist', () => {
      const store = new DataStore();
      expect(store.del(['missing'])).toBe(0);
    });

    it('counts only the keys that actually existed, across multiple keys', () => {
      const store = new DataStore();
      store.set('a', '1');
      store.set('b', '2');
      expect(store.del(['a', 'missing', 'b'])).toBe(2);
      expect(store.size).toBe(0);
    });
  });

  describe('exists', () => {
    it('counts existing keys', () => {
      const store = new DataStore();
      store.set('a', '1');
      store.set('b', '2');
      expect(store.exists(['a', 'b', 'missing'])).toBe(2);
    });

    it('counts a repeated key once per occurrence in the input, matching real Redis', () => {
      const store = new DataStore();
      store.set('a', '1');
      expect(store.exists(['a', 'a'])).toBe(2);
    });

    it('returns 0 for an empty store', () => {
      const store = new DataStore();
      expect(store.exists(['a'])).toBe(0);
    });
  });

  it('tracks size as keys are added and removed', () => {
    const store = new DataStore();
    expect(store.size).toBe(0);
    store.set('a', '1');
    store.set('b', '2');
    expect(store.size).toBe(2);
    store.del(['a']);
    expect(store.size).toBe(1);
  });

  describe('lists', () => {
    describe('lpush', () => {
      it('creates a list and returns the new length', () => {
        const store = new DataStore();
        expect(store.lpush('mylist', ['a'])).toBe(1);
      });

      it('pushes each value in order, so the last one ends up at the head', () => {
        const store = new DataStore();
        store.lpush('mylist', ['a', 'b', 'c']);
        expect(store.lrange('mylist', 0, -1)).toEqual(['c', 'b', 'a']);
      });

      it('prepends onto an existing list', () => {
        const store = new DataStore();
        store.lpush('mylist', ['a']);
        store.lpush('mylist', ['b']);
        expect(store.lrange('mylist', 0, -1)).toEqual(['b', 'a']);
      });

      it('throws WrongTypeError when the key holds a string', () => {
        const store = new DataStore();
        store.set('foo', 'bar');
        expect(() => store.lpush('foo', ['x'])).toThrow(WrongTypeError);
      });
    });

    describe('rpush', () => {
      it('creates a list and returns the new length', () => {
        const store = new DataStore();
        expect(store.rpush('mylist', ['a'])).toBe(1);
      });

      it('appends each value in order', () => {
        const store = new DataStore();
        store.rpush('mylist', ['a', 'b', 'c']);
        expect(store.lrange('mylist', 0, -1)).toEqual(['a', 'b', 'c']);
      });

      it('appends onto an existing list', () => {
        const store = new DataStore();
        store.rpush('mylist', ['a']);
        store.rpush('mylist', ['b']);
        expect(store.lrange('mylist', 0, -1)).toEqual(['a', 'b']);
      });

      it('throws WrongTypeError when the key holds a string', () => {
        const store = new DataStore();
        store.set('foo', 'bar');
        expect(() => store.rpush('foo', ['x'])).toThrow(WrongTypeError);
      });
    });

    describe('lpop', () => {
      it('removes and returns the first element', () => {
        const store = new DataStore();
        store.rpush('mylist', ['a', 'b', 'c']);
        expect(store.lpop('mylist')).toBe('a');
        expect(store.lrange('mylist', 0, -1)).toEqual(['b', 'c']);
      });

      it('returns null for a key that does not exist', () => {
        const store = new DataStore();
        expect(store.lpop('missing')).toBeNull();
      });

      it('removes the key once the list becomes empty', () => {
        const store = new DataStore();
        store.rpush('mylist', ['only']);
        expect(store.lpop('mylist')).toBe('only');
        expect(store.lpop('mylist')).toBeNull();
        expect(store.size).toBe(0);
      });

      it('throws WrongTypeError when the key holds a string', () => {
        const store = new DataStore();
        store.set('foo', 'bar');
        expect(() => store.lpop('foo')).toThrow(WrongTypeError);
      });
    });

    describe('rpop', () => {
      it('removes and returns the last element', () => {
        const store = new DataStore();
        store.rpush('mylist', ['a', 'b', 'c']);
        expect(store.rpop('mylist')).toBe('c');
        expect(store.lrange('mylist', 0, -1)).toEqual(['a', 'b']);
      });

      it('returns null for a key that does not exist', () => {
        const store = new DataStore();
        expect(store.rpop('missing')).toBeNull();
      });

      it('removes the key once the list becomes empty', () => {
        const store = new DataStore();
        store.rpush('mylist', ['only']);
        expect(store.rpop('mylist')).toBe('only');
        expect(store.size).toBe(0);
      });

      it('throws WrongTypeError when the key holds a string', () => {
        const store = new DataStore();
        store.set('foo', 'bar');
        expect(() => store.rpop('foo')).toThrow(WrongTypeError);
      });
    });

    describe('lrange', () => {
      it('returns the full list with 0 -1', () => {
        const store = new DataStore();
        store.rpush('mylist', ['a', 'b', 'c']);
        expect(store.lrange('mylist', 0, -1)).toEqual(['a', 'b', 'c']);
      });

      it('returns a sub-range', () => {
        const store = new DataStore();
        store.rpush('mylist', ['a', 'b', 'c', 'd']);
        expect(store.lrange('mylist', 1, 2)).toEqual(['b', 'c']);
      });

      it('supports negative indices counting from the end', () => {
        const store = new DataStore();
        store.rpush('mylist', ['a', 'b', 'c', 'd']);
        expect(store.lrange('mylist', -2, -1)).toEqual(['c', 'd']);
        expect(store.lrange('mylist', -100, -1)).toEqual(['a', 'b', 'c', 'd']);
      });

      it('clamps a stop index beyond the end of the list', () => {
        const store = new DataStore();
        store.rpush('mylist', ['a', 'b']);
        expect(store.lrange('mylist', 0, 100)).toEqual(['a', 'b']);
      });

      it('returns an empty array when start > stop', () => {
        const store = new DataStore();
        store.rpush('mylist', ['a', 'b', 'c']);
        expect(store.lrange('mylist', 2, 1)).toEqual([]);
      });

      it('returns an empty array for a key that does not exist', () => {
        const store = new DataStore();
        expect(store.lrange('missing', 0, -1)).toEqual([]);
      });

      it('throws WrongTypeError when the key holds a string', () => {
        const store = new DataStore();
        store.set('foo', 'bar');
        expect(() => store.lrange('foo', 0, -1)).toThrow(WrongTypeError);
      });
    });

    describe('llen', () => {
      it('returns the number of elements', () => {
        const store = new DataStore();
        store.rpush('mylist', ['a', 'b', 'c']);
        expect(store.llen('mylist')).toBe(3);
      });

      it('returns 0 for a key that does not exist', () => {
        const store = new DataStore();
        expect(store.llen('missing')).toBe(0);
      });

      it('throws WrongTypeError when the key holds a string', () => {
        const store = new DataStore();
        store.set('foo', 'bar');
        expect(() => store.llen('foo')).toThrow(WrongTypeError);
      });
    });
  });

  describe('hashes', () => {
    describe('hset', () => {
      it('creates a hash and returns how many fields were newly added', () => {
        const store = new DataStore();
        expect(store.hset('myhash', [['field1', 'a']])).toBe(1);
      });

      it('counts multiple new fields set in one call', () => {
        const store = new DataStore();
        expect(
          store.hset('myhash', [
            ['field1', 'a'],
            ['field2', 'b'],
          ]),
        ).toBe(2);
      });

      it('does not count an overwritten field as newly added', () => {
        const store = new DataStore();
        store.hset('myhash', [['field1', 'a']]);
        expect(store.hset('myhash', [['field1', 'b']])).toBe(0);
        expect(store.hget('myhash', 'field1')).toBe('b');
      });

      it('counts a mix of new and overwritten fields correctly', () => {
        const store = new DataStore();
        store.hset('myhash', [['field1', 'a']]);
        expect(
          store.hset('myhash', [
            ['field1', 'z'],
            ['field2', 'b'],
          ]),
        ).toBe(1);
      });

      it('throws WrongTypeError when the key holds a string', () => {
        const store = new DataStore();
        store.set('foo', 'bar');
        expect(() => store.hset('foo', [['field1', 'a']])).toThrow(WrongTypeError);
      });

      it('throws WrongTypeError when the key holds a list', () => {
        const store = new DataStore();
        store.rpush('mylist', ['a']);
        expect(() => store.hset('mylist', [['field1', 'a']])).toThrow(WrongTypeError);
      });
    });

    describe('hget', () => {
      it('returns the value for an existing field', () => {
        const store = new DataStore();
        store.hset('myhash', [['field1', 'a']]);
        expect(store.hget('myhash', 'field1')).toBe('a');
      });

      it('returns null for a missing field on an existing hash', () => {
        const store = new DataStore();
        store.hset('myhash', [['field1', 'a']]);
        expect(store.hget('myhash', 'missing')).toBeNull();
      });

      it('returns null for a key that does not exist', () => {
        const store = new DataStore();
        expect(store.hget('missing', 'field1')).toBeNull();
      });

      it('throws WrongTypeError when the key holds a string', () => {
        const store = new DataStore();
        store.set('foo', 'bar');
        expect(() => store.hget('foo', 'field1')).toThrow(WrongTypeError);
      });
    });

    describe('hdel', () => {
      it('deletes existing fields and returns the count removed', () => {
        const store = new DataStore();
        store.hset('myhash', [
          ['field1', 'a'],
          ['field2', 'b'],
        ]);
        expect(store.hdel('myhash', ['field1', 'missing'])).toBe(1);
        expect(store.hget('myhash', 'field1')).toBeNull();
        expect(store.hget('myhash', 'field2')).toBe('b');
      });

      it('returns 0 for a key that does not exist', () => {
        const store = new DataStore();
        expect(store.hdel('missing', ['field1'])).toBe(0);
      });

      it('removes the key once the hash becomes empty', () => {
        const store = new DataStore();
        store.hset('myhash', [['only', 'a']]);
        expect(store.hdel('myhash', ['only'])).toBe(1);
        expect(store.size).toBe(0);
        expect(store.hget('myhash', 'only')).toBeNull();
      });

      it('throws WrongTypeError when the key holds a string', () => {
        const store = new DataStore();
        store.set('foo', 'bar');
        expect(() => store.hdel('foo', ['field1'])).toThrow(WrongTypeError);
      });
    });

    describe('hgetall', () => {
      it('returns all field/value pairs', () => {
        const store = new DataStore();
        store.hset('myhash', [
          ['field1', 'a'],
          ['field2', 'b'],
        ]);
        expect(store.hgetall('myhash')).toEqual([
          ['field1', 'a'],
          ['field2', 'b'],
        ]);
      });

      it('returns an empty array for a key that does not exist', () => {
        const store = new DataStore();
        expect(store.hgetall('missing')).toEqual([]);
      });

      it('throws WrongTypeError when the key holds a string', () => {
        const store = new DataStore();
        store.set('foo', 'bar');
        expect(() => store.hgetall('foo')).toThrow(WrongTypeError);
      });
    });

    describe('hexists', () => {
      it('returns true for an existing field', () => {
        const store = new DataStore();
        store.hset('myhash', [['field1', 'a']]);
        expect(store.hexists('myhash', 'field1')).toBe(true);
      });

      it('returns false for a missing field or key', () => {
        const store = new DataStore();
        store.hset('myhash', [['field1', 'a']]);
        expect(store.hexists('myhash', 'missing')).toBe(false);
        expect(store.hexists('missing', 'field1')).toBe(false);
      });

      it('throws WrongTypeError when the key holds a string', () => {
        const store = new DataStore();
        store.set('foo', 'bar');
        expect(() => store.hexists('foo', 'field1')).toThrow(WrongTypeError);
      });
    });

    describe('hlen', () => {
      it('returns the number of fields', () => {
        const store = new DataStore();
        store.hset('myhash', [
          ['field1', 'a'],
          ['field2', 'b'],
        ]);
        expect(store.hlen('myhash')).toBe(2);
      });

      it('returns 0 for a key that does not exist', () => {
        const store = new DataStore();
        expect(store.hlen('missing')).toBe(0);
      });

      it('throws WrongTypeError when the key holds a string', () => {
        const store = new DataStore();
        store.set('foo', 'bar');
        expect(() => store.hlen('foo')).toThrow(WrongTypeError);
      });
    });
  });

  describe('sets', () => {
    describe('sadd', () => {
      it('creates a set and returns how many members were newly added', () => {
        const store = new DataStore();
        expect(store.sadd('myset', ['a', 'b'])).toBe(2);
      });

      it('does not count an already-present member as newly added', () => {
        const store = new DataStore();
        store.sadd('myset', ['a']);
        expect(store.sadd('myset', ['a'])).toBe(0);
      });

      it('counts a mix of new and duplicate members correctly', () => {
        const store = new DataStore();
        store.sadd('myset', ['a']);
        expect(store.sadd('myset', ['a', 'b', 'c'])).toBe(2);
      });

      it('de-duplicates members added within the same call', () => {
        const store = new DataStore();
        expect(store.sadd('myset', ['a', 'a', 'a'])).toBe(1);
        expect(store.scard('myset')).toBe(1);
      });

      it('throws WrongTypeError when the key holds a string', () => {
        const store = new DataStore();
        store.set('foo', 'bar');
        expect(() => store.sadd('foo', ['a'])).toThrow(WrongTypeError);
      });

      it('throws WrongTypeError when the key holds a list', () => {
        const store = new DataStore();
        store.rpush('mylist', ['a']);
        expect(() => store.sadd('mylist', ['a'])).toThrow(WrongTypeError);
      });

      it('throws WrongTypeError when the key holds a hash', () => {
        const store = new DataStore();
        store.hset('myhash', [['field1', 'a']]);
        expect(() => store.sadd('myhash', ['a'])).toThrow(WrongTypeError);
      });
    });

    describe('srem', () => {
      it('removes existing members and returns the count removed', () => {
        const store = new DataStore();
        store.sadd('myset', ['a', 'b', 'c']);
        expect(store.srem('myset', ['a', 'missing'])).toBe(1);
        expect(store.sismember('myset', 'a')).toBe(false);
        expect(store.sismember('myset', 'b')).toBe(true);
      });

      it('returns 0 for a key that does not exist', () => {
        const store = new DataStore();
        expect(store.srem('missing', ['a'])).toBe(0);
      });

      it('removes the key once the set becomes empty', () => {
        const store = new DataStore();
        store.sadd('myset', ['only']);
        expect(store.srem('myset', ['only'])).toBe(1);
        expect(store.size).toBe(0);
        expect(store.scard('myset')).toBe(0);
      });

      it('throws WrongTypeError when the key holds a string', () => {
        const store = new DataStore();
        store.set('foo', 'bar');
        expect(() => store.srem('foo', ['a'])).toThrow(WrongTypeError);
      });
    });

    describe('smembers', () => {
      it('returns all members', () => {
        const store = new DataStore();
        store.sadd('myset', ['a', 'b', 'c']);
        expect(store.smembers('myset').sort()).toEqual(['a', 'b', 'c']);
      });

      it('returns an empty array for a key that does not exist', () => {
        const store = new DataStore();
        expect(store.smembers('missing')).toEqual([]);
      });

      it('throws WrongTypeError when the key holds a string', () => {
        const store = new DataStore();
        store.set('foo', 'bar');
        expect(() => store.smembers('foo')).toThrow(WrongTypeError);
      });
    });

    describe('sismember', () => {
      it('returns true for an existing member', () => {
        const store = new DataStore();
        store.sadd('myset', ['a']);
        expect(store.sismember('myset', 'a')).toBe(true);
      });

      it('returns false for a missing member or key', () => {
        const store = new DataStore();
        store.sadd('myset', ['a']);
        expect(store.sismember('myset', 'missing')).toBe(false);
        expect(store.sismember('missing', 'a')).toBe(false);
      });

      it('throws WrongTypeError when the key holds a string', () => {
        const store = new DataStore();
        store.set('foo', 'bar');
        expect(() => store.sismember('foo', 'a')).toThrow(WrongTypeError);
      });
    });

    describe('scard', () => {
      it('returns the number of members', () => {
        const store = new DataStore();
        store.sadd('myset', ['a', 'b', 'c']);
        expect(store.scard('myset')).toBe(3);
      });

      it('returns 0 for a key that does not exist', () => {
        const store = new DataStore();
        expect(store.scard('missing')).toBe(0);
      });

      it('throws WrongTypeError when the key holds a string', () => {
        const store = new DataStore();
        store.set('foo', 'bar');
        expect(() => store.scard('foo')).toThrow(WrongTypeError);
      });
    });
  });

  describe('cross-type behavior', () => {
    it('get() throws WrongTypeError when the key holds a list', () => {
      const store = new DataStore();
      store.rpush('mylist', ['a']);
      expect(() => store.get('mylist')).toThrow(WrongTypeError);
    });

    it('get() throws WrongTypeError when the key holds a hash', () => {
      const store = new DataStore();
      store.hset('myhash', [['field1', 'a']]);
      expect(() => store.get('myhash')).toThrow(WrongTypeError);
    });

    it('lpush() throws WrongTypeError when the key holds a hash', () => {
      const store = new DataStore();
      store.hset('myhash', [['field1', 'a']]);
      expect(() => store.lpush('myhash', ['x'])).toThrow(WrongTypeError);
    });

    it('set() overwrites a list key with a string, discarding the list', () => {
      const store = new DataStore();
      store.rpush('mylist', ['a', 'b']);
      store.set('mylist', 'now a string');
      expect(store.get('mylist')).toBe('now a string');
      // The key is a string now, so a list operation correctly rejects it —
      // confirms the old list data is gone, not just shadowed.
      expect(() => store.llen('mylist')).toThrow(WrongTypeError);
    });

    it('set() overwrites a hash key with a string, discarding the hash', () => {
      const store = new DataStore();
      store.hset('myhash', [['field1', 'a']]);
      store.set('myhash', 'now a string');
      expect(store.get('myhash')).toBe('now a string');
      expect(() => store.hlen('myhash')).toThrow(WrongTypeError);
    });

    it('get() throws WrongTypeError when the key holds a set', () => {
      const store = new DataStore();
      store.sadd('myset', ['a']);
      expect(() => store.get('myset')).toThrow(WrongTypeError);
    });

    it('sadd() throws WrongTypeError when the key holds a list', () => {
      const store = new DataStore();
      store.rpush('mylist', ['a']);
      expect(() => store.sadd('mylist', ['a'])).toThrow(WrongTypeError);
    });

    it('lpush() throws WrongTypeError when the key holds a set', () => {
      const store = new DataStore();
      store.sadd('myset', ['a']);
      expect(() => store.lpush('myset', ['a'])).toThrow(WrongTypeError);
    });

    it('set() overwrites a set key with a string, discarding the set', () => {
      const store = new DataStore();
      store.sadd('myset', ['a']);
      store.set('myset', 'now a string');
      expect(store.get('myset')).toBe('now a string');
      expect(() => store.scard('myset')).toThrow(WrongTypeError);
    });

    it('del() and exists() work regardless of value type', () => {
      const store = new DataStore();
      store.rpush('mylist', ['a']);
      expect(store.exists(['mylist'])).toBe(1);
      expect(store.del(['mylist'])).toBe(1);
      expect(store.exists(['mylist'])).toBe(0);
    });
  });

  describe('expiry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    describe('passive expiry', () => {
      it('get() returns the value before the TTL passes', () => {
        const store = new DataStore();
        store.set('foo', 'bar', Date.now() + 1000);
        expect(store.get('foo')).toBe('bar');
      });

      it('get() returns null once the TTL has passed, without anything else cleaning it up', () => {
        const store = new DataStore();
        store.set('foo', 'bar', Date.now() + 100);
        vi.advanceTimersByTime(200);
        expect(store.get('foo')).toBeNull();
      });

      it('an expired key is actually removed from the store on access, not just hidden', () => {
        const store = new DataStore();
        store.set('foo', 'bar', Date.now() + 100);
        vi.advanceTimersByTime(200);
        store.get('foo'); // triggers lazy deletion
        expect(store.size).toBe(0);
      });

      it('exists() does not count an expired key', () => {
        const store = new DataStore();
        store.set('foo', 'bar', Date.now() + 100);
        vi.advanceTimersByTime(200);
        expect(store.exists(['foo'])).toBe(0);
      });

      it('del() does not count an expired key as removed', () => {
        const store = new DataStore();
        store.set('foo', 'bar', Date.now() + 100);
        vi.advanceTimersByTime(200);
        expect(store.del(['foo'])).toBe(0);
      });

      it('applies to lists, hashes, and sets too, not just strings', () => {
        const store = new DataStore();
        store.rpush('mylist', ['a', 'b']);
        store.expireAt('mylist', Date.now() + 100);
        store.hset('myhash', [['field1', 'a']]);
        store.expireAt('myhash', Date.now() + 100);
        store.sadd('myset', ['a']);
        store.expireAt('myset', Date.now() + 100);

        vi.advanceTimersByTime(200);

        expect(store.lrange('mylist', 0, -1)).toEqual([]);
        expect(store.llen('mylist')).toBe(0);
        expect(store.hgetall('myhash')).toEqual([]);
        expect(store.hlen('myhash')).toBe(0);
        expect(store.smembers('myset')).toEqual([]);
        expect(store.scard('myset')).toBe(0);
      });

      it('an expired key can be recreated as a different type without WRONGTYPE', () => {
        const store = new DataStore();
        store.set('foo', 'a string', Date.now() + 100);
        vi.advanceTimersByTime(200);
        // If the expired string entry weren't purged first, this would
        // incorrectly throw WrongTypeError instead of creating a list.
        expect(() => store.lpush('foo', ['x'])).not.toThrow();
        expect(store.lrange('foo', 0, -1)).toEqual(['x']);
      });

      it('re-SET after expiry behaves like setting a brand-new key', () => {
        const store = new DataStore();
        store.set('foo', 'old', Date.now() + 100);
        vi.advanceTimersByTime(200);
        store.set('foo', 'new');
        expect(store.get('foo')).toBe('new');
        expect(store.getEntry('foo')?.expiresAt).toBeNull();
      });
    });

    describe('expireAt', () => {
      it('sets an expiry on an existing key and returns true', () => {
        const store = new DataStore();
        store.set('foo', 'bar');
        expect(store.expireAt('foo', Date.now() + 1000)).toBe(true);
        expect(store.getEntry('foo')?.expiresAt).not.toBeNull();
      });

      it('returns false for a key that does not exist', () => {
        const store = new DataStore();
        expect(store.expireAt('missing', Date.now() + 1000)).toBe(false);
      });

      it('overwrites an existing expiry', () => {
        const store = new DataStore();
        store.set('foo', 'bar', Date.now() + 1000);
        store.expireAt('foo', Date.now() + 5000);
        expect(store.getEntry('foo')?.expiresAt).toBe(Date.now() + 5000);
      });
    });

    describe('persist', () => {
      it('removes an existing expiry and returns true', () => {
        const store = new DataStore();
        store.set('foo', 'bar', Date.now() + 1000);
        expect(store.persist('foo')).toBe(true);
        expect(store.getEntry('foo')?.expiresAt).toBeNull();
      });

      it('returns false for a key with no expiry', () => {
        const store = new DataStore();
        store.set('foo', 'bar');
        expect(store.persist('foo')).toBe(false);
      });

      it('returns false for a key that does not exist', () => {
        const store = new DataStore();
        expect(store.persist('missing')).toBe(false);
      });

      it('a persisted key survives past its old TTL', () => {
        const store = new DataStore();
        store.set('foo', 'bar', Date.now() + 100);
        store.persist('foo');
        vi.advanceTimersByTime(200);
        expect(store.get('foo')).toBe('bar');
      });
    });

    describe('pttl', () => {
      it('returns -2 for a key that does not exist', () => {
        const store = new DataStore();
        expect(store.pttl('missing')).toBe(-2);
      });

      it('returns -1 for a key that exists but has no expiry', () => {
        const store = new DataStore();
        store.set('foo', 'bar');
        expect(store.pttl('foo')).toBe(-1);
      });

      it('returns the remaining milliseconds for a key with an expiry', () => {
        const store = new DataStore();
        store.set('foo', 'bar', Date.now() + 5000);
        expect(store.pttl('foo')).toBe(5000);
        vi.advanceTimersByTime(2000);
        expect(store.pttl('foo')).toBe(3000);
      });

      it('returns -2 once the key has passively expired', () => {
        const store = new DataStore();
        store.set('foo', 'bar', Date.now() + 100);
        vi.advanceTimersByTime(200);
        expect(store.pttl('foo')).toBe(-2);
      });
    });

    describe('sweepExpired (active expiry)', () => {
      it('removes an expired key even though nothing has read it', () => {
        const store = new DataStore();
        store.set('foo', 'bar', Date.now() + 100);
        vi.advanceTimersByTime(200);

        expect(store.sweepExpired(10)).toBe(1);
        expect(store.size).toBe(0);
      });

      it('never touches keys without a TTL', () => {
        const store = new DataStore();
        store.set('permanent', 'value');
        vi.advanceTimersByTime(10_000);

        expect(store.sweepExpired(10)).toBe(0);
        expect(store.get('permanent')).toBe('value');
      });

      it('leaves keys with an unexpired TTL alone', () => {
        const store = new DataStore();
        store.set('foo', 'bar', Date.now() + 10_000);

        expect(store.sweepExpired(10)).toBe(0);
        expect(store.get('foo')).toBe('bar');
      });

      it('bounds work per call to sampleSize, even when more keys are expired', () => {
        const store = new DataStore();
        for (let i = 0; i < 10; i++) {
          store.set(`k${i}`, 'v', Date.now() + 100);
        }
        vi.advanceTimersByTime(200);

        expect(store.sweepExpired(3)).toBe(3);
        expect(store.size).toBe(7);

        // Calling it repeatedly eventually clears the rest.
        expect(store.sweepExpired(3)).toBe(3);
        expect(store.sweepExpired(3)).toBe(3);
        expect(store.sweepExpired(3)).toBe(1);
        expect(store.size).toBe(0);
      });

      it('does not scan the whole keyspace — only keys that currently have a TTL', () => {
        const store = new DataStore();
        for (let i = 0; i < 100; i++) {
          store.set(`permanent${i}`, 'v'); // no TTL
        }
        store.set('expiring', 'v', Date.now() + 100);
        vi.advanceTimersByTime(200);

        // A tiny sample size still finds the one expiring key instead of
        // getting lost among 100 permanent ones.
        expect(store.sweepExpired(1)).toBe(1);
      });
    });
  });
});
