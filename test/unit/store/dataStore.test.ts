import { describe, expect, it } from 'vitest';
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

  describe('cross-type behavior', () => {
    it('get() throws WrongTypeError when the key holds a list', () => {
      const store = new DataStore();
      store.rpush('mylist', ['a']);
      expect(() => store.get('mylist')).toThrow(WrongTypeError);
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

    it('del() and exists() work regardless of value type', () => {
      const store = new DataStore();
      store.rpush('mylist', ['a']);
      expect(store.exists(['mylist'])).toBe(1);
      expect(store.del(['mylist'])).toBe(1);
      expect(store.exists(['mylist'])).toBe(0);
    });
  });
});
