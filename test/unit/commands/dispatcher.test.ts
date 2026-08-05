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
});
