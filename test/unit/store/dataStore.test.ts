import { describe, expect, it } from 'vitest';
import { DataStore } from '../../../src/store/dataStore.js';

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
});
