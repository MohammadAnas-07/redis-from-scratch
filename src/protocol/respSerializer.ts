// Encodes RESP values into wire-format bytes for writing to a client socket.
import { type RespValue } from './respTypes.js';

const CRLF = '\r\n';

export function encodeResp(value: RespValue): Buffer {
  switch (value.type) {
    case 'simple':
      assertNoCRLF(value.value, 'simple string');
      return Buffer.from(`+${value.value}${CRLF}`, 'utf8');
    case 'error':
      assertNoCRLF(value.value, 'error');
      return Buffer.from(`-${value.value}${CRLF}`, 'utf8');
    case 'integer':
      return Buffer.from(`:${value.value}${CRLF}`, 'utf8');
    case 'bulk':
      return encodeBulkString(value.value);
    case 'array':
      return encodeArray(value.value);
  }
}

function encodeBulkString(value: string | null): Buffer {
  if (value === null) {
    return Buffer.from(`$-1${CRLF}`, 'utf8');
  }
  const payload = Buffer.from(value, 'utf8');
  const header = Buffer.from(`$${payload.length}${CRLF}`, 'utf8');
  return Buffer.concat([header, payload, Buffer.from(CRLF, 'utf8')]);
}

function encodeArray(items: RespValue[] | null): Buffer {
  if (items === null) {
    return Buffer.from(`*-1${CRLF}`, 'utf8');
  }
  const header = Buffer.from(`*${items.length}${CRLF}`, 'utf8');
  return Buffer.concat([header, ...items.map(encodeResp)]);
}

function assertNoCRLF(value: string, kind: string): void {
  if (value.includes('\r') || value.includes('\n')) {
    throw new Error(`RESP ${kind} value must not contain CR or LF: ${JSON.stringify(value)}`);
  }
}
