// Round-trip tests: encode a value, feed the resulting bytes back through
// the parser, and confirm we get the original value back out.
import { describe, expect, it } from 'vitest';
import { RespParser } from '../../../src/protocol/respParser.js';
import { encodeResp } from '../../../src/protocol/respSerializer.js';
import {
  array,
  bulkString,
  error,
  integer,
  nullArray,
  nullBulkString,
  simpleString,
  type RespValue,
} from '../../../src/protocol/respTypes.js';

function roundTrip(value: RespValue): RespValue[] {
  return new RespParser().push(encodeResp(value));
}

describe('RESP encode -> decode round trip', () => {
  const cases: Array<[string, RespValue]> = [
    ['simple string', simpleString('OK')],
    ['error', error('ERR something bad happened')],
    ['positive integer', integer(1000)],
    ['negative integer', integer(-42)],
    ['zero', integer(0)],
    ['bulk string', bulkString('foobar')],
    ['empty bulk string', bulkString('')],
    ['null bulk string', nullBulkString()],
    ['array of bulk strings', array([bulkString('foo'), bulkString('bar')])],
    ['empty array', array([])],
    ['null array', nullArray()],
    [
      'nested array',
      array([integer(1), array([bulkString('a'), nullBulkString()]), simpleString('OK')]),
    ],
    ['multi-byte utf8 bulk string', bulkString('héllo wörld 🎉')],
  ];

  it.each(cases)('round-trips a %s', (_label, value) => {
    expect(roundTrip(value)).toEqual([value]);
  });

  it('round-trips several pipelined values fed through one buffer', () => {
    const values: RespValue[] = [simpleString('OK'), integer(5), bulkString('hi')];
    const encoded = Buffer.concat(values.map(encodeResp));
    expect(new RespParser().push(encoded)).toEqual(values);
  });

  it('round-trips a RESP array shaped like a real command (e.g. SET foo bar)', () => {
    const command = array([bulkString('SET'), bulkString('foo'), bulkString('bar')]);
    expect(roundTrip(command)).toEqual([command]);
  });
});
