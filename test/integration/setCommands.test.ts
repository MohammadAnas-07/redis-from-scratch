// Integration tests: real TcpServer, real dispatcher, real DataStore — the
// exact wiring src/index.ts does — driven over a real TCP socket with real
// RESP-encoded SADD/SREM/SMEMBERS/SISMEMBER/SCARD requests, asserting on
// real RESP-encoded responses.
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatch } from '../../src/commands/dispatcher.js';
import { RespParser } from '../../src/protocol/respParser.js';
import { encodeResp } from '../../src/protocol/respSerializer.js';
import { array, bulkString, integer, type RespValue } from '../../src/protocol/respTypes.js';
import { TcpServer } from '../../src/server/tcpServer.js';
import { DataStore } from '../../src/store/dataStore.js';

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.on('error', () => {});
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function getPort(server: TcpServer): number {
  const address = server.address;
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to have a bound AddressInfo');
  }
  return address.port;
}

/** Sends one RESP command and resolves with the single decoded reply. */
function sendCommand(socket: net.Socket, args: string[]): Promise<RespValue> {
  return new Promise((resolve) => {
    socket.once('data', (data: Buffer) => {
      const [reply] = new RespParser().push(data);
      resolve(reply);
    });
    socket.write(encodeResp(array(args.map((a) => bulkString(a)))));
  });
}

/** Extracts and sorts the bulk-string members from a RESP array reply, for order-independent comparison. */
function membersOf(reply: RespValue): (string | null)[] {
  if (reply.type !== 'array' || reply.value === null) {
    throw new Error(`expected a RESP array reply, got ${reply.type}`);
  }
  return reply.value
    .map((item) => (item.type === 'bulk' ? item.value : null))
    .sort((a, b) => (a ?? '').localeCompare(b ?? ''));
}

describe('set commands (end-to-end over a real socket)', () => {
  let server: TcpServer;
  let socket: net.Socket;
  let port: number;

  beforeEach(async () => {
    const store = new DataStore();
    server = new TcpServer({
      port: 0,
      host: '127.0.0.1',
      dispatch: (request) => dispatch(store, request),
    });
    await server.listen();
    port = getPort(server);
    socket = await connect(port);
  });

  afterEach(async () => {
    socket.destroy();
    await server.close();
  });

  it('SADD creates a set and returns the number of newly added members', async () => {
    expect(await sendCommand(socket, ['SADD', 'tags', 'redis', 'db'])).toEqual(integer(2));
  });

  it('SADD returns 0 for members already present, and de-dupes within one call', async () => {
    await sendCommand(socket, ['SADD', 'tags', 'redis']);
    expect(await sendCommand(socket, ['SADD', 'tags', 'redis'])).toEqual(integer(0));
    expect(await sendCommand(socket, ['SADD', 'tags2', 'a', 'a', 'a'])).toEqual(integer(1));
  });

  it('SMEMBERS returns every member', async () => {
    await sendCommand(socket, ['SADD', 'tags', 'redis', 'db', 'cache']);
    const reply = await sendCommand(socket, ['SMEMBERS', 'tags']);
    expect(membersOf(reply)).toEqual(['cache', 'db', 'redis']);
  });

  it('SMEMBERS on a missing key returns an empty array', async () => {
    expect(await sendCommand(socket, ['SMEMBERS', 'missing'])).toEqual(array([]));
  });

  it('SISMEMBER reports membership as 1 or 0', async () => {
    await sendCommand(socket, ['SADD', 'tags', 'redis']);
    expect(await sendCommand(socket, ['SISMEMBER', 'tags', 'redis'])).toEqual(integer(1));
    expect(await sendCommand(socket, ['SISMEMBER', 'tags', 'missing'])).toEqual(integer(0));
    expect(await sendCommand(socket, ['SISMEMBER', 'missing', 'redis'])).toEqual(integer(0));
  });

  it('SCARD reflects the current member count, including 0 for a missing key', async () => {
    expect(await sendCommand(socket, ['SCARD', 'tags'])).toEqual(integer(0));
    await sendCommand(socket, ['SADD', 'tags', 'redis', 'db']);
    expect(await sendCommand(socket, ['SCARD', 'tags'])).toEqual(integer(2));
  });

  it('SREM removes members and reports the count removed', async () => {
    await sendCommand(socket, ['SADD', 'tags', 'redis', 'db', 'cache']);
    expect(await sendCommand(socket, ['SREM', 'tags', 'redis', 'missing'])).toEqual(integer(1));
    expect(await sendCommand(socket, ['SISMEMBER', 'tags', 'redis'])).toEqual(integer(0));
    expect(membersOf(await sendCommand(socket, ['SMEMBERS', 'tags']))).toEqual(['cache', 'db']);
  });

  it('a set key is removed once emptied by SREM', async () => {
    await sendCommand(socket, ['SADD', 'tags', 'only']);
    await sendCommand(socket, ['SREM', 'tags', 'only']);
    expect(await sendCommand(socket, ['EXISTS', 'tags'])).toEqual(integer(0));
  });

  describe('WRONGTYPE errors', () => {
    it('SADD on a key holding a string returns a RESP error over the wire', async () => {
      await sendCommand(socket, ['SET', 'foo', 'bar']);
      const reply = await sendCommand(socket, ['SADD', 'foo', 'x']);
      expect(reply).toEqual({
        type: 'error',
        value: 'WRONGTYPE Operation against a key holding the wrong kind of value',
      });
    });

    it('SADD on a key holding a list returns a RESP error over the wire', async () => {
      await sendCommand(socket, ['RPUSH', 'mylist', 'a']);
      const reply = await sendCommand(socket, ['SADD', 'mylist', 'x']);
      expect(reply.type).toBe('error');
    });

    it('SADD on a key holding a hash returns a RESP error over the wire', async () => {
      await sendCommand(socket, ['HSET', 'myhash', 'field1', 'a']);
      const reply = await sendCommand(socket, ['SADD', 'myhash', 'x']);
      expect(reply.type).toBe('error');
    });

    it('GET on a key holding a set returns a RESP error over the wire', async () => {
      await sendCommand(socket, ['SADD', 'myset', 'a']);
      const reply = await sendCommand(socket, ['GET', 'myset']);
      expect(reply.type).toBe('error');
    });

    it('HSET on a key holding a set returns a RESP error over the wire', async () => {
      await sendCommand(socket, ['SADD', 'myset', 'a']);
      const reply = await sendCommand(socket, ['HSET', 'myset', 'field1', 'a']);
      expect(reply.type).toBe('error');
    });

    it('the string value is left untouched after a rejected SADD', async () => {
      await sendCommand(socket, ['SET', 'foo', 'bar']);
      await sendCommand(socket, ['SADD', 'foo', 'x']);
      expect(await sendCommand(socket, ['GET', 'foo'])).toEqual(bulkString('bar'));
    });
  });

  it('runs a realistic set command sequence end to end', async () => {
    expect(await sendCommand(socket, ['SADD', 'tags', 'redis'])).toEqual(integer(1));
    expect(await sendCommand(socket, ['SADD', 'tags', 'db', 'cache'])).toEqual(integer(2));
    expect(await sendCommand(socket, ['SCARD', 'tags'])).toEqual(integer(3));
    expect(await sendCommand(socket, ['SISMEMBER', 'tags', 'db'])).toEqual(integer(1));
    expect(await sendCommand(socket, ['SREM', 'tags', 'db'])).toEqual(integer(1));
    expect(membersOf(await sendCommand(socket, ['SMEMBERS', 'tags']))).toEqual(['cache', 'redis']);
  });
});
