// Shared RESP value types and constructor helpers, used by both the parser
// and the serializer so neither module has to depend on the other's
// internals.
//
// Note on binary safety: real RESP bulk strings can carry arbitrary binary
// payloads. This module treats bulk/simple/error string content as UTF-8
// text, which covers every command this project targets (see
// ARCHITECTURE.md non-goals). True binary-safe payloads are out of scope.

export type RespValue = RespSimpleString | RespError | RespInteger | RespBulkString | RespArray;

export interface RespSimpleString {
  readonly type: 'simple';
  readonly value: string;
}

export interface RespError {
  readonly type: 'error';
  readonly value: string;
}

export interface RespInteger {
  readonly type: 'integer';
  readonly value: number;
}

/** `value: null` represents the RESP null bulk string (`$-1\r\n`). */
export interface RespBulkString {
  readonly type: 'bulk';
  readonly value: string | null;
}

/** `value: null` represents the RESP null array (`*-1\r\n`). */
export interface RespArray {
  readonly type: 'array';
  readonly value: RespValue[] | null;
}

export function simpleString(value: string): RespSimpleString {
  return { type: 'simple', value };
}

export function error(value: string): RespError {
  return { type: 'error', value };
}

export function integer(value: number): RespInteger {
  return { type: 'integer', value };
}

export function bulkString(value: string | null): RespBulkString {
  return { type: 'bulk', value };
}

export function nullBulkString(): RespBulkString {
  return bulkString(null);
}

export function array(value: RespValue[] | null): RespArray {
  return { type: 'array', value };
}

export function nullArray(): RespArray {
  return array(null);
}

/**
 * Thrown when the byte stream violates the RESP protocol — as opposed to
 * simply being incomplete, which the parser handles by waiting for more
 * data rather than throwing.
 */
export class RespProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RespProtocolError';
  }
}
