import { describe, expect, it } from 'vitest';
import { encodeResp } from '../../../src/protocol/respSerializer.js';
import {
  array,
  bulkString,
  error,
  integer,
  nullArray,
  nullBulkString,
  simpleString,
} from '../../../src/protocol/respTypes.js';

describe('encodeResp', () => {
  it('encodes a simple string', () => {
    expect(encodeResp(simpleString('OK'))).toEqual(Buffer.from('+OK\r\n'));
  });

  it('encodes an error', () => {
    expect(encodeResp(error('ERR unknown command'))).toEqual(
      Buffer.from('-ERR unknown command\r\n'),
    );
  });

  it('encodes a positive integer', () => {
    expect(encodeResp(integer(1000))).toEqual(Buffer.from(':1000\r\n'));
  });

  it('encodes zero', () => {
    expect(encodeResp(integer(0))).toEqual(Buffer.from(':0\r\n'));
  });

  it('encodes a negative integer', () => {
    expect(encodeResp(integer(-1))).toEqual(Buffer.from(':-1\r\n'));
  });

  it('encodes a bulk string', () => {
    expect(encodeResp(bulkString('foobar'))).toEqual(Buffer.from('$6\r\nfoobar\r\n'));
  });

  it('encodes an empty (non-null) bulk string', () => {
    expect(encodeResp(bulkString(''))).toEqual(Buffer.from('$0\r\n\r\n'));
  });

  it('encodes a null bulk string', () => {
    expect(encodeResp(bulkString(null))).toEqual(Buffer.from('$-1\r\n'));
    expect(encodeResp(nullBulkString())).toEqual(Buffer.from('$-1\r\n'));
  });

  it('uses the utf8 byte length, not the character length, for multi-byte bulk strings', () => {
    // 'é' is 1 JS character but 2 bytes in utf8.
    expect(encodeResp(bulkString('é'))).toEqual(Buffer.from('$2\r\né\r\n'));
  });

  it('encodes an array of bulk strings', () => {
    expect(encodeResp(array([bulkString('foo'), bulkString('bar')]))).toEqual(
      Buffer.from('*2\r\n$3\r\nfoo\r\n$3\r\nbar\r\n'),
    );
  });

  it('encodes an empty (non-null) array', () => {
    expect(encodeResp(array([]))).toEqual(Buffer.from('*0\r\n'));
  });

  it('encodes a null array', () => {
    expect(encodeResp(array(null))).toEqual(Buffer.from('*-1\r\n'));
    expect(encodeResp(nullArray())).toEqual(Buffer.from('*-1\r\n'));
  });

  it('encodes a nested array', () => {
    const value = array([integer(1), array([bulkString('a'), nullBulkString()])]);
    expect(encodeResp(value)).toEqual(Buffer.from('*2\r\n:1\r\n*2\r\n$1\r\na\r\n$-1\r\n'));
  });

  it('encodes a heterogeneous array (RESP arrays are not typed)', () => {
    const value = array([simpleString('OK'), error('ERR bad'), integer(5)]);
    const expected = Buffer.concat([
      Buffer.from('*3\r\n'),
      Buffer.from('+OK\r\n'),
      Buffer.from('-ERR bad\r\n'),
      Buffer.from(':5\r\n'),
    ]);
    expect(encodeResp(value)).toEqual(expected);
  });

  it('rejects a simple string containing CRLF', () => {
    expect(() => encodeResp(simpleString('bad\r\nvalue'))).toThrow();
  });

  it('rejects an error containing a bare LF', () => {
    expect(() => encodeResp(error('bad\nvalue'))).toThrow();
  });
});
