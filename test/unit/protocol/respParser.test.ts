import { describe, expect, it } from 'vitest';
import { RespParser } from '../../../src/protocol/respParser.js';
import { RespProtocolError } from '../../../src/protocol/respTypes.js';

function parseOnce(text: string) {
  return new RespParser().push(Buffer.from(text, 'utf8'));
}

describe('RespParser', () => {
  it('parses a simple string', () => {
    expect(parseOnce('+OK\r\n')).toEqual([{ type: 'simple', value: 'OK' }]);
  });

  it('parses an error', () => {
    expect(parseOnce('-ERR unknown command\r\n')).toEqual([
      { type: 'error', value: 'ERR unknown command' },
    ]);
  });

  it('parses a positive integer', () => {
    expect(parseOnce(':1000\r\n')).toEqual([{ type: 'integer', value: 1000 }]);
  });

  it('parses a negative integer', () => {
    expect(parseOnce(':-5\r\n')).toEqual([{ type: 'integer', value: -5 }]);
  });

  it('rejects a malformed integer', () => {
    expect(() => parseOnce(':not-a-number\r\n')).toThrow(RespProtocolError);
  });

  it('parses a bulk string', () => {
    expect(parseOnce('$6\r\nfoobar\r\n')).toEqual([{ type: 'bulk', value: 'foobar' }]);
  });

  it('parses an empty (non-null) bulk string', () => {
    expect(parseOnce('$0\r\n\r\n')).toEqual([{ type: 'bulk', value: '' }]);
  });

  it('parses a null bulk string', () => {
    expect(parseOnce('$-1\r\n')).toEqual([{ type: 'bulk', value: null }]);
  });

  it('rejects a bulk string with a malformed length', () => {
    expect(() => parseOnce('$abc\r\nfoo\r\n')).toThrow(RespProtocolError);
  });

  it('rejects a bulk string whose payload is missing its terminating CRLF', () => {
    expect(() => parseOnce('$3\r\nfooXX')).toThrow(RespProtocolError);
  });

  it('parses an array of bulk strings', () => {
    expect(parseOnce('*2\r\n$3\r\nfoo\r\n$3\r\nbar\r\n')).toEqual([
      {
        type: 'array',
        value: [
          { type: 'bulk', value: 'foo' },
          { type: 'bulk', value: 'bar' },
        ],
      },
    ]);
  });

  it('parses an empty (non-null) array', () => {
    expect(parseOnce('*0\r\n')).toEqual([{ type: 'array', value: [] }]);
  });

  it('parses a null array', () => {
    expect(parseOnce('*-1\r\n')).toEqual([{ type: 'array', value: null }]);
  });

  it('parses a nested array', () => {
    expect(parseOnce('*2\r\n:1\r\n*1\r\n$1\r\na\r\n')).toEqual([
      {
        type: 'array',
        value: [
          { type: 'integer', value: 1 },
          { type: 'array', value: [{ type: 'bulk', value: 'a' }] },
        ],
      },
    ]);
  });

  it('rejects an unknown type byte', () => {
    expect(() => parseOnce('!bad\r\n')).toThrow(RespProtocolError);
  });

  it('parses multiple pipelined values delivered in a single chunk', () => {
    expect(parseOnce('+OK\r\n:1\r\n$3\r\nfoo\r\n')).toEqual([
      { type: 'simple', value: 'OK' },
      { type: 'integer', value: 1 },
      { type: 'bulk', value: 'foo' },
    ]);
  });

  describe('fragmented / partial reads', () => {
    it('buffers a simple string split across two chunks', () => {
      const parser = new RespParser();
      expect(parser.push(Buffer.from('+OK'))).toEqual([]);
      expect(parser.pendingByteLength).toBe(3);
      expect(parser.push(Buffer.from('\r\n'))).toEqual([{ type: 'simple', value: 'OK' }]);
      expect(parser.pendingByteLength).toBe(0);
    });

    it('buffers an integer split mid-digits', () => {
      const parser = new RespParser();
      expect(parser.push(Buffer.from(':12'))).toEqual([]);
      expect(parser.push(Buffer.from('34\r\n'))).toEqual([{ type: 'integer', value: 1234 }]);
    });

    it('buffers a bulk string fed one byte at a time', () => {
      const parser = new RespParser();
      const full = '$6\r\nfoobar\r\n';
      let result: unknown[] = [];
      for (const byte of Buffer.from(full)) {
        result = parser.push(Buffer.from([byte]));
      }
      expect(result).toEqual([{ type: 'bulk', value: 'foobar' }]);
    });

    it('buffers when only the bulk string length header has arrived', () => {
      const parser = new RespParser();
      expect(parser.push(Buffer.from('$6\r\n'))).toEqual([]);
      expect(parser.push(Buffer.from('foo'))).toEqual([]);
      expect(parser.push(Buffer.from('bar\r\n'))).toEqual([{ type: 'bulk', value: 'foobar' }]);
    });

    it('buffers an array split mid-element', () => {
      const parser = new RespParser();
      expect(parser.push(Buffer.from('*2\r\n$3\r\nfo'))).toEqual([]);
      expect(parser.push(Buffer.from('o\r\n$3\r\nbar\r\n'))).toEqual([
        {
          type: 'array',
          value: [
            { type: 'bulk', value: 'foo' },
            { type: 'bulk', value: 'bar' },
          ],
        },
      ]);
    });

    it('buffers an array split between its header and its first element', () => {
      const parser = new RespParser();
      expect(parser.push(Buffer.from('*2\r\n'))).toEqual([]);
      expect(parser.push(Buffer.from('$3\r\nfoo\r\n$3\r\nbar\r\n'))).toEqual([
        {
          type: 'array',
          value: [
            { type: 'bulk', value: 'foo' },
            { type: 'bulk', value: 'bar' },
          ],
        },
      ]);
    });

    it('returns a complete value while keeping a trailing partial one buffered', () => {
      const parser = new RespParser();
      expect(parser.push(Buffer.from('+OK\r\n:1'))).toEqual([{ type: 'simple', value: 'OK' }]);
      expect(parser.pendingByteLength).toBe(2); // ':1' buffered so far

      expect(parser.push(Buffer.from('0\r\n'))).toEqual([{ type: 'integer', value: 10 }]);
      expect(parser.pendingByteLength).toBe(0);
    });

    it('reassembles a realistic multi-bulk command split across many small TCP packets', () => {
      const parser = new RespParser();
      const command = '*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n';

      // Split into fixed-size chunks. Deliberately not a regex-based
      // splitter: `.` excludes line terminators without the `s` flag, which
      // would silently drop the \r\n bytes this test depends on.
      const chunkSize = 5;
      const chunks: string[] = [];
      for (let i = 0; i < command.length; i += chunkSize) {
        chunks.push(command.slice(i, i + chunkSize));
      }

      const result: unknown[] = [];
      for (const chunk of chunks) {
        result.push(...parser.push(Buffer.from(chunk)));
      }

      expect(result).toEqual([
        {
          type: 'array',
          value: [
            { type: 'bulk', value: 'SET' },
            { type: 'bulk', value: 'foo' },
            { type: 'bulk', value: 'bar' },
          ],
        },
      ]);
      expect(parser.pendingByteLength).toBe(0);
    });
  });
});
