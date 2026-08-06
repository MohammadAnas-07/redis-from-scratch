import { describe, expect, it } from 'vitest';
import { dispatch } from '../../../src/commands/dispatcher.js';
import {
  array,
  bulkString,
  integer,
  nullArray,
  simpleString,
  type RespValue,
} from '../../../src/protocol/respTypes.js';
import { DataStore } from '../../../src/store/dataStore.js';

/** Builds a RESP request the way a real client would send a command. */
function cmd(...args: string[]): RespValue {
  return array(args.map((a) => bulkString(a)));
}

describe('dispatch', () => {
  describe('request-shape validation', () => {
    it('rejects a request that is not an array', () => {
      const store = new DataStore();
      const reply = dispatch(store, simpleString('PING'));
      expect(reply.type).toBe('error');
    });

    it('rejects a null array request', () => {
      const store = new DataStore();
      expect(dispatch(store, nullArray()).type).toBe('error');
    });

    it('rejects an array containing a non-bulk-string element', () => {
      const store = new DataStore();
      const reply = dispatch(store, array([bulkString('SET'), integer(1)]));
      expect(reply.type).toBe('error');
    });

    it('rejects an empty command array', () => {
      const store = new DataStore();
      expect(dispatch(store, array([]))).toEqual({ type: 'error', value: 'ERR empty command' });
    });

    it('rejects an unknown command', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('NOPE'))).toEqual({
        type: 'error',
        value: "ERR unknown command 'NOPE'",
      });
    });

    it('is case-insensitive for command names', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('ping'))).toEqual(simpleString('PONG'));
      expect(dispatch(store, cmd('PiNg'))).toEqual(simpleString('PONG'));
    });
  });

  describe('PING', () => {
    it('replies +PONG with no arguments', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('PING'))).toEqual(simpleString('PONG'));
    });

    it('echoes its single argument as a bulk string', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('PING', 'hello'))).toEqual(bulkString('hello'));
    });

    it('rejects more than one argument', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('PING', 'a', 'b')).type).toBe('error');
    });
  });

  describe('SET / GET', () => {
    it('sets then gets a value', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('SET', 'foo', 'bar'))).toEqual(simpleString('OK'));
      expect(dispatch(store, cmd('GET', 'foo'))).toEqual(bulkString('bar'));
    });

    it('GET on a missing key returns a null bulk string', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('GET', 'missing'))).toEqual(bulkString(null));
    });

    it('rejects SET with too few arguments', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('SET', 'onlykey')).type).toBe('error');
    });

    it('rejects GET with the wrong number of arguments', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('GET')).type).toBe('error');
      expect(dispatch(store, cmd('GET', 'a', 'b')).type).toBe('error');
    });

    it('parses and stores an EX expiry as an absolute ms timestamp', () => {
      const store = new DataStore();
      const before = Date.now();
      const reply = dispatch(store, cmd('SET', 'foo', 'bar', 'EX', '10'));
      const after = Date.now();

      expect(reply).toEqual(simpleString('OK'));
      const entry = store.getEntry('foo');
      expect(entry?.expiresAt).not.toBeNull();
      expect(entry?.expiresAt).toBeGreaterThanOrEqual(before + 10_000);
      expect(entry?.expiresAt).toBeLessThanOrEqual(after + 10_000);
    });

    it('parses and stores a PX expiry as an absolute ms timestamp', () => {
      const store = new DataStore();
      const before = Date.now();
      dispatch(store, cmd('SET', 'foo', 'bar', 'PX', '500'));
      const after = Date.now();

      const entry = store.getEntry('foo');
      expect(entry?.expiresAt).toBeGreaterThanOrEqual(before + 500);
      expect(entry?.expiresAt).toBeLessThanOrEqual(after + 500);
    });

    it('is case-insensitive for the EX/PX keyword', () => {
      const store = new DataStore();
      dispatch(store, cmd('SET', 'foo', 'bar', 'ex', '10'));
      expect(store.getEntry('foo')?.expiresAt).not.toBeNull();
    });

    it('does not set an expiry when none is given', () => {
      const store = new DataStore();
      dispatch(store, cmd('SET', 'foo', 'bar'));
      expect(store.getEntry('foo')?.expiresAt).toBeNull();
    });

    it('rejects an unknown SET option', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('SET', 'foo', 'bar', 'NX', '10'))).toEqual({
        type: 'error',
        value: 'ERR syntax error',
      });
    });

    it('rejects a non-integer expiry amount', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('SET', 'foo', 'bar', 'EX', 'soon'))).toEqual({
        type: 'error',
        value: 'ERR value is not an integer or out of range',
      });
    });

    it('rejects a zero or negative expiry amount', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('SET', 'foo', 'bar', 'EX', '0')).type).toBe('error');
      expect(dispatch(store, cmd('SET', 'foo', 'bar', 'EX', '-5')).type).toBe('error');
    });

    it('rejects a dangling EX/PX option with no amount', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('SET', 'foo', 'bar', 'EX')).type).toBe('error');
    });

    it('overwrites an existing value and clears a stale expiry', () => {
      const store = new DataStore();
      dispatch(store, cmd('SET', 'foo', 'bar', 'EX', '10'));
      dispatch(store, cmd('SET', 'foo', 'baz'));
      const entry = store.getEntry('foo');
      expect(entry?.value).toBe('baz');
      expect(entry?.expiresAt).toBeNull();
    });
  });

  describe('DEL', () => {
    it('deletes existing keys and returns the count removed', () => {
      const store = new DataStore();
      dispatch(store, cmd('SET', 'a', '1'));
      dispatch(store, cmd('SET', 'b', '2'));
      expect(dispatch(store, cmd('DEL', 'a', 'b', 'missing'))).toEqual(integer(2));
      expect(dispatch(store, cmd('GET', 'a'))).toEqual(bulkString(null));
    });

    it('returns 0 when nothing matched', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('DEL', 'missing'))).toEqual(integer(0));
    });

    it('requires at least one key', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('DEL')).type).toBe('error');
    });
  });

  describe('EXISTS', () => {
    it('counts how many of the given keys exist', () => {
      const store = new DataStore();
      dispatch(store, cmd('SET', 'a', '1'));
      expect(dispatch(store, cmd('EXISTS', 'a', 'missing'))).toEqual(integer(1));
    });

    it('counts a repeated key once per occurrence', () => {
      const store = new DataStore();
      dispatch(store, cmd('SET', 'a', '1'));
      expect(dispatch(store, cmd('EXISTS', 'a', 'a'))).toEqual(integer(2));
    });

    it('requires at least one key', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('EXISTS')).type).toBe('error');
    });
  });

  describe('LPUSH / RPUSH', () => {
    it('LPUSH creates a list and returns the new length', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('LPUSH', 'mylist', 'a', 'b', 'c'))).toEqual(integer(3));
    });

    it('LPUSH pushes each value in order, so the last one ends up at the head', () => {
      const store = new DataStore();
      dispatch(store, cmd('LPUSH', 'mylist', 'a', 'b', 'c'));
      expect(dispatch(store, cmd('LRANGE', 'mylist', '0', '-1'))).toEqual(
        array([bulkString('c'), bulkString('b'), bulkString('a')]),
      );
    });

    it('RPUSH appends each value in order', () => {
      const store = new DataStore();
      dispatch(store, cmd('RPUSH', 'mylist', 'a', 'b', 'c'));
      expect(dispatch(store, cmd('LRANGE', 'mylist', '0', '-1'))).toEqual(
        array([bulkString('a'), bulkString('b'), bulkString('c')]),
      );
    });

    it('requires at least a key and one value', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('LPUSH', 'mylist')).type).toBe('error');
      expect(dispatch(store, cmd('RPUSH', 'mylist')).type).toBe('error');
    });

    it('returns WRONGTYPE for LPUSH/RPUSH on a string key', () => {
      const store = new DataStore();
      dispatch(store, cmd('SET', 'foo', 'bar'));
      const expected = {
        type: 'error',
        value: 'WRONGTYPE Operation against a key holding the wrong kind of value',
      };
      expect(dispatch(store, cmd('LPUSH', 'foo', 'x'))).toEqual(expected);
      expect(dispatch(store, cmd('RPUSH', 'foo', 'x'))).toEqual(expected);
    });
  });

  describe('LPOP / RPOP', () => {
    it('LPOP removes and returns the first element', () => {
      const store = new DataStore();
      dispatch(store, cmd('RPUSH', 'mylist', 'a', 'b'));
      expect(dispatch(store, cmd('LPOP', 'mylist'))).toEqual(bulkString('a'));
    });

    it('RPOP removes and returns the last element', () => {
      const store = new DataStore();
      dispatch(store, cmd('RPUSH', 'mylist', 'a', 'b'));
      expect(dispatch(store, cmd('RPOP', 'mylist'))).toEqual(bulkString('b'));
    });

    it('returns a null bulk string for a missing key', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('LPOP', 'missing'))).toEqual(bulkString(null));
      expect(dispatch(store, cmd('RPOP', 'missing'))).toEqual(bulkString(null));
    });

    it('removes the key once the list empties, reflected in EXISTS', () => {
      const store = new DataStore();
      dispatch(store, cmd('RPUSH', 'mylist', 'only'));
      dispatch(store, cmd('LPOP', 'mylist'));
      expect(dispatch(store, cmd('EXISTS', 'mylist'))).toEqual(integer(0));
    });

    it('returns WRONGTYPE on a string key', () => {
      const store = new DataStore();
      dispatch(store, cmd('SET', 'foo', 'bar'));
      expect(dispatch(store, cmd('LPOP', 'foo')).type).toBe('error');
      expect(dispatch(store, cmd('RPOP', 'foo')).type).toBe('error');
    });
  });

  describe('LRANGE', () => {
    it('returns the full list with 0 -1', () => {
      const store = new DataStore();
      dispatch(store, cmd('RPUSH', 'mylist', 'a', 'b', 'c'));
      expect(dispatch(store, cmd('LRANGE', 'mylist', '0', '-1'))).toEqual(
        array([bulkString('a'), bulkString('b'), bulkString('c')]),
      );
    });

    it('supports negative indices', () => {
      const store = new DataStore();
      dispatch(store, cmd('RPUSH', 'mylist', 'a', 'b', 'c'));
      expect(dispatch(store, cmd('LRANGE', 'mylist', '-2', '-1'))).toEqual(
        array([bulkString('b'), bulkString('c')]),
      );
    });

    it('returns an empty array for a missing key', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('LRANGE', 'missing', '0', '-1'))).toEqual(array([]));
    });

    it('rejects non-integer start/stop', () => {
      const store = new DataStore();
      dispatch(store, cmd('RPUSH', 'mylist', 'a'));
      expect(dispatch(store, cmd('LRANGE', 'mylist', 'zero', '-1'))).toEqual({
        type: 'error',
        value: 'ERR value is not an integer or out of range',
      });
    });

    it('returns WRONGTYPE on a string key', () => {
      const store = new DataStore();
      dispatch(store, cmd('SET', 'foo', 'bar'));
      expect(dispatch(store, cmd('LRANGE', 'foo', '0', '-1')).type).toBe('error');
    });
  });

  describe('LLEN', () => {
    it('returns the number of elements', () => {
      const store = new DataStore();
      dispatch(store, cmd('RPUSH', 'mylist', 'a', 'b', 'c'));
      expect(dispatch(store, cmd('LLEN', 'mylist'))).toEqual(integer(3));
    });

    it('returns 0 for a missing key', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('LLEN', 'missing'))).toEqual(integer(0));
    });

    it('returns WRONGTYPE on a string key', () => {
      const store = new DataStore();
      dispatch(store, cmd('SET', 'foo', 'bar'));
      expect(dispatch(store, cmd('LLEN', 'foo')).type).toBe('error');
    });
  });

  describe('HSET / HGET', () => {
    it('HSET creates a hash and returns the number of new fields', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('HSET', 'myhash', 'field1', 'a'))).toEqual(integer(1));
    });

    it('HSET returns 0 when overwriting only existing fields', () => {
      const store = new DataStore();
      dispatch(store, cmd('HSET', 'myhash', 'field1', 'a'));
      expect(dispatch(store, cmd('HSET', 'myhash', 'field1', 'b'))).toEqual(integer(0));
    });

    it('HSET accepts multiple field/value pairs in one call', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('HSET', 'myhash', 'field1', 'a', 'field2', 'b'))).toEqual(
        integer(2),
      );
    });

    it('HGET returns the stored value', () => {
      const store = new DataStore();
      dispatch(store, cmd('HSET', 'myhash', 'field1', 'a'));
      expect(dispatch(store, cmd('HGET', 'myhash', 'field1'))).toEqual(bulkString('a'));
    });

    it('HGET returns a null bulk string for a missing field or key', () => {
      const store = new DataStore();
      dispatch(store, cmd('HSET', 'myhash', 'field1', 'a'));
      expect(dispatch(store, cmd('HGET', 'myhash', 'missing'))).toEqual(bulkString(null));
      expect(dispatch(store, cmd('HGET', 'missing', 'field1'))).toEqual(bulkString(null));
    });

    it('HSET rejects an odd number of field/value tokens', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('HSET', 'myhash', 'field1', 'a', 'field2')).type).toBe('error');
    });

    it('returns WRONGTYPE on a string key', () => {
      const store = new DataStore();
      dispatch(store, cmd('SET', 'foo', 'bar'));
      const expected = {
        type: 'error',
        value: 'WRONGTYPE Operation against a key holding the wrong kind of value',
      };
      expect(dispatch(store, cmd('HSET', 'foo', 'field1', 'a'))).toEqual(expected);
      expect(dispatch(store, cmd('HGET', 'foo', 'field1'))).toEqual(expected);
    });
  });

  describe('HDEL', () => {
    it('deletes existing fields and returns the count removed', () => {
      const store = new DataStore();
      dispatch(store, cmd('HSET', 'myhash', 'field1', 'a', 'field2', 'b'));
      expect(dispatch(store, cmd('HDEL', 'myhash', 'field1', 'missing'))).toEqual(integer(1));
    });

    it('removes the key once the hash empties, reflected in EXISTS', () => {
      const store = new DataStore();
      dispatch(store, cmd('HSET', 'myhash', 'only', 'a'));
      dispatch(store, cmd('HDEL', 'myhash', 'only'));
      expect(dispatch(store, cmd('EXISTS', 'myhash'))).toEqual(integer(0));
    });

    it('returns WRONGTYPE on a string key', () => {
      const store = new DataStore();
      dispatch(store, cmd('SET', 'foo', 'bar'));
      expect(dispatch(store, cmd('HDEL', 'foo', 'field1')).type).toBe('error');
    });
  });

  describe('HGETALL', () => {
    it('returns all fields and values as a flat array', () => {
      const store = new DataStore();
      dispatch(store, cmd('HSET', 'myhash', 'field1', 'a', 'field2', 'b'));
      expect(dispatch(store, cmd('HGETALL', 'myhash'))).toEqual(
        array([bulkString('field1'), bulkString('a'), bulkString('field2'), bulkString('b')]),
      );
    });

    it('returns an empty array for a missing key', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('HGETALL', 'missing'))).toEqual(array([]));
    });

    it('returns WRONGTYPE on a string key', () => {
      const store = new DataStore();
      dispatch(store, cmd('SET', 'foo', 'bar'));
      expect(dispatch(store, cmd('HGETALL', 'foo')).type).toBe('error');
    });
  });

  describe('HEXISTS', () => {
    it('returns 1 for an existing field and 0 otherwise', () => {
      const store = new DataStore();
      dispatch(store, cmd('HSET', 'myhash', 'field1', 'a'));
      expect(dispatch(store, cmd('HEXISTS', 'myhash', 'field1'))).toEqual(integer(1));
      expect(dispatch(store, cmd('HEXISTS', 'myhash', 'missing'))).toEqual(integer(0));
      expect(dispatch(store, cmd('HEXISTS', 'missing', 'field1'))).toEqual(integer(0));
    });

    it('returns WRONGTYPE on a string key', () => {
      const store = new DataStore();
      dispatch(store, cmd('SET', 'foo', 'bar'));
      expect(dispatch(store, cmd('HEXISTS', 'foo', 'field1')).type).toBe('error');
    });
  });

  describe('HLEN', () => {
    it('returns the number of fields', () => {
      const store = new DataStore();
      dispatch(store, cmd('HSET', 'myhash', 'field1', 'a', 'field2', 'b'));
      expect(dispatch(store, cmd('HLEN', 'myhash'))).toEqual(integer(2));
    });

    it('returns 0 for a missing key', () => {
      const store = new DataStore();
      expect(dispatch(store, cmd('HLEN', 'missing'))).toEqual(integer(0));
    });

    it('returns WRONGTYPE on a string key', () => {
      const store = new DataStore();
      dispatch(store, cmd('SET', 'foo', 'bar'));
      expect(dispatch(store, cmd('HLEN', 'foo')).type).toBe('error');
    });
  });

  describe('cross-type errors surfaced through dispatch', () => {
    it('GET on a list key returns WRONGTYPE', () => {
      const store = new DataStore();
      dispatch(store, cmd('RPUSH', 'mylist', 'a'));
      expect(dispatch(store, cmd('GET', 'mylist'))).toEqual({
        type: 'error',
        value: 'WRONGTYPE Operation against a key holding the wrong kind of value',
      });
    });

    it('GET on a hash key returns WRONGTYPE', () => {
      const store = new DataStore();
      dispatch(store, cmd('HSET', 'myhash', 'field1', 'a'));
      expect(dispatch(store, cmd('GET', 'myhash'))).toEqual({
        type: 'error',
        value: 'WRONGTYPE Operation against a key holding the wrong kind of value',
      });
    });

    it('LPUSH on a hash key returns WRONGTYPE', () => {
      const store = new DataStore();
      dispatch(store, cmd('HSET', 'myhash', 'field1', 'a'));
      expect(dispatch(store, cmd('LPUSH', 'myhash', 'x')).type).toBe('error');
    });

    it('HSET on a list key returns WRONGTYPE', () => {
      const store = new DataStore();
      dispatch(store, cmd('RPUSH', 'mylist', 'a'));
      expect(dispatch(store, cmd('HSET', 'mylist', 'field1', 'a')).type).toBe('error');
    });
  });
});
