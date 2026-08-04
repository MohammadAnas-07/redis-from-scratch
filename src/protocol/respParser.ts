// Streaming RESP decoder: turns buffered incoming bytes into parsed
// commands. TCP gives no message boundaries, so a command can legitimately
// arrive split across several reads (or several commands can arrive in one
// read, when pipelined) — RespParser buffers internally and only ever
// yields complete values.
import {
  array,
  bulkString,
  error,
  integer,
  RespProtocolError,
  simpleString,
  type RespValue,
} from './respTypes.js';

const TYPE_SIMPLE = 0x2b; // '+'
const TYPE_ERROR = 0x2d; // '-'
const TYPE_INTEGER = 0x3a; // ':'
const TYPE_BULK = 0x24; // '$'
const TYPE_ARRAY = 0x2a; // '*'
const CR = 0x0d;
const LF = 0x0a;

const INTEGER_RE = /^-?\d+$/;

interface ParseResult {
  value: RespValue;
  /** Offset into the buffer right after this value's bytes. */
  next: number;
}

interface Line {
  text: string;
  next: number;
}

/** Finds the line ending at the next CRLF starting from `start`, or null if not yet buffered. */
function readLine(buf: Buffer, start: number): Line | null {
  const idx = buf.indexOf('\r\n', start, 'utf8');
  if (idx === -1) return null;
  return { text: buf.toString('utf8', start, idx), next: idx + 2 };
}

/** Reads a RESP length/count prefix line (used by both bulk strings and arrays). */
function readLength(
  buf: Buffer,
  start: number,
  kind: string,
): { length: number; next: number } | null {
  const line = readLine(buf, start);
  if (line === null) return null;
  if (!INTEGER_RE.test(line.text)) {
    throw new RespProtocolError(`invalid ${kind} length: ${JSON.stringify(line.text)}`);
  }
  return { length: Number(line.text), next: line.next };
}

function parseSimpleString(buf: Buffer, start: number): ParseResult | null {
  const line = readLine(buf, start);
  if (line === null) return null;
  return { value: simpleString(line.text), next: line.next };
}

function parseError(buf: Buffer, start: number): ParseResult | null {
  const line = readLine(buf, start);
  if (line === null) return null;
  return { value: error(line.text), next: line.next };
}

function parseInteger(buf: Buffer, start: number): ParseResult | null {
  const line = readLine(buf, start);
  if (line === null) return null;
  if (!INTEGER_RE.test(line.text)) {
    throw new RespProtocolError(`invalid RESP integer: ${JSON.stringify(line.text)}`);
  }
  return { value: integer(Number(line.text)), next: line.next };
}

function parseBulkString(buf: Buffer, start: number): ParseResult | null {
  const header = readLength(buf, start, 'bulk string');
  if (header === null) return null;

  const { length } = header;
  if (length === -1) {
    return { value: bulkString(null), next: header.next };
  }
  if (length < -1) {
    throw new RespProtocolError(`invalid bulk string length: ${length}`);
  }

  const dataStart = header.next;
  const dataEnd = dataStart + length;
  const messageEnd = dataEnd + 2;
  if (buf.length < messageEnd) return null; // payload and/or trailing CRLF not fully buffered yet

  if (buf[dataEnd] !== CR || buf[dataEnd + 1] !== LF) {
    throw new RespProtocolError('bulk string is missing its terminating CRLF');
  }

  return { value: bulkString(buf.toString('utf8', dataStart, dataEnd)), next: messageEnd };
}

function parseArray(buf: Buffer, start: number): ParseResult | null {
  const header = readLength(buf, start, 'array');
  if (header === null) return null;

  const { length: count } = header;
  if (count === -1) {
    return { value: array(null), next: header.next };
  }
  if (count < -1) {
    throw new RespProtocolError(`invalid array length: ${count}`);
  }

  let offset = header.next;
  const items: RespValue[] = [];
  for (let i = 0; i < count; i++) {
    const item = parseValue(buf, offset);
    if (item === null) return null; // an element isn't fully buffered yet
    items.push(item.value);
    offset = item.next;
  }

  return { value: array(items), next: offset };
}

/**
 * Attempts to parse one complete RESP value starting at `offset`.
 * Returns null when the buffer doesn't yet contain a complete value (wait
 * for more data). Throws RespProtocolError on malformed input.
 */
function parseValue(buf: Buffer, offset: number): ParseResult | null {
  if (offset >= buf.length) return null;

  switch (buf[offset]) {
    case TYPE_SIMPLE:
      return parseSimpleString(buf, offset + 1);
    case TYPE_ERROR:
      return parseError(buf, offset + 1);
    case TYPE_INTEGER:
      return parseInteger(buf, offset + 1);
    case TYPE_BULK:
      return parseBulkString(buf, offset + 1);
    case TYPE_ARRAY:
      return parseArray(buf, offset + 1);
    default:
      throw new RespProtocolError(
        `unexpected RESP type byte: ${JSON.stringify(String.fromCharCode(buf[offset] ?? 0))}`,
      );
  }
}

/**
 * Stateful, streaming RESP decoder for a single connection. Feed it raw
 * bytes as they arrive off the socket; it hands back every value that is
 * now complete and keeps any trailing partial message buffered internally.
 */
export class RespParser {
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Feeds newly-received bytes into the parser. Returns every complete RESP
   * value that can now be extracted — zero (nothing complete yet), one, or
   * more (multiple pipelined messages can arrive in a single chunk).
   *
   * Throws RespProtocolError if the buffered bytes violate the protocol.
   * The connection should be treated as unusable after that.
   */
  push(chunk: Buffer): RespValue[] {
    this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk;

    const values: RespValue[] = [];
    let offset = 0;
    for (;;) {
      const result = parseValue(this.buffer, offset);
      if (result === null) break;
      values.push(result.value);
      offset = result.next;
    }

    if (offset > 0) {
      this.buffer = this.buffer.subarray(offset);
    }

    return values;
  }

  /** Bytes currently buffered while waiting for the rest of an in-flight message. */
  get pendingByteLength(): number {
    return this.buffer.length;
  }
}
