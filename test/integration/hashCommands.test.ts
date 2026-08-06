// Integration tests: real TcpServer, real dispatcher, real DataStore — the
// exact wiring src/index.ts does — driven over a real TCP socket with real
// RESP-encoded HSET/HGET/HDEL/HGETALL/HEXISTS/HLEN requests, asserting on
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

describe('hash commands (end-to-end over a real socket)', () => {
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

  it('HSET then HGET round-trips a field', async () => {
    expect(await sendCommand(socket, ['HSET', 'user:1', 'name', 'anas'])).toEqual(integer(1));
    expect(await sendCommand(socket, ['HGET', 'user:1', 'name'])).toEqual(bulkString('anas'));
  });

  it('HSET returns the count of newly added fields, not total fields touched', async () => {
    expect(await sendCommand(socket, ['HSET', 'user:1', 'name', 'anas'])).toEqual(integer(1));
    expect(await sendCommand(socket, ['HSET', 'user:1', 'name', 'updated', 'age', '30'])).toEqual(
      integer(1),
    );
  });

  it('HGET on a missing field or key returns a null bulk string', async () => {
    await sendCommand(socket, ['HSET', 'user:1', 'name', 'anas']);
    expect(await sendCommand(socket, ['HGET', 'user:1', 'missing'])).toEqual(bulkString(null));
    expect(await sendCommand(socket, ['HGET', 'nope', 'name'])).toEqual(bulkString(null));
  });

  it('HGETALL returns every field/value pair as a flat array', async () => {
    await sendCommand(socket, ['HSET', 'user:1', 'name', 'anas', 'age', '30']);
    expect(await sendCommand(socket, ['HGETALL', 'user:1'])).toEqual(
      array([bulkString('name'), bulkString('anas'), bulkString('age'), bulkString('30')]),
    );
  });

  it('HGETALL on a missing key returns an empty array', async () => {
    expect(await sendCommand(socket, ['HGETALL', 'missing'])).toEqual(array([]));
  });

  it('HEXISTS reports field presence', async () => {
    await sendCommand(socket, ['HSET', 'user:1', 'name', 'anas']);
    expect(await sendCommand(socket, ['HEXISTS', 'user:1', 'name'])).toEqual(integer(1));
    expect(await sendCommand(socket, ['HEXISTS', 'user:1', 'missing'])).toEqual(integer(0));
  });

  it('HLEN reflects the current field count, including 0 for a missing key', async () => {
    expect(await sendCommand(socket, ['HLEN', 'user:1'])).toEqual(integer(0));
    await sendCommand(socket, ['HSET', 'user:1', 'name', 'anas', 'age', '30']);
    expect(await sendCommand(socket, ['HLEN', 'user:1'])).toEqual(integer(2));
  });

  it('HDEL removes fields and reports the count removed', async () => {
    await sendCommand(socket, ['HSET', 'user:1', 'name', 'anas', 'age', '30']);
    expect(await sendCommand(socket, ['HDEL', 'user:1', 'age', 'missing'])).toEqual(integer(1));
    expect(await sendCommand(socket, ['HGET', 'user:1', 'age'])).toEqual(bulkString(null));
    expect(await sendCommand(socket, ['HGET', 'user:1', 'name'])).toEqual(bulkString('anas'));
  });

  it('a hash key is removed once emptied by HDEL', async () => {
    await sendCommand(socket, ['HSET', 'user:1', 'only', 'field']);
    await sendCommand(socket, ['HDEL', 'user:1', 'only']);
    expect(await sendCommand(socket, ['EXISTS', 'user:1'])).toEqual(integer(0));
  });

  describe('WRONGTYPE errors', () => {
    it('HSET on a key holding a string returns a RESP error over the wire', async () => {
      await sendCommand(socket, ['SET', 'foo', 'bar']);
      const reply = await sendCommand(socket, ['HSET', 'foo', 'field1', 'a']);
      expect(reply).toEqual({
        type: 'error',
        value: 'WRONGTYPE Operation against a key holding the wrong kind of value',
      });
    });

    it('HSET on a key holding a list returns a RESP error over the wire', async () => {
      await sendCommand(socket, ['RPUSH', 'mylist', 'a']);
      const reply = await sendCommand(socket, ['HSET', 'mylist', 'field1', 'a']);
      expect(reply.type).toBe('error');
    });

    it('GET on a key holding a hash returns a RESP error over the wire', async () => {
      await sendCommand(socket, ['HSET', 'myhash', 'field1', 'a']);
      const reply = await sendCommand(socket, ['GET', 'myhash']);
      expect(reply.type).toBe('error');
    });

    it('LPUSH on a key holding a hash returns a RESP error over the wire', async () => {
      await sendCommand(socket, ['HSET', 'myhash', 'field1', 'a']);
      const reply = await sendCommand(socket, ['LPUSH', 'myhash', 'x']);
      expect(reply.type).toBe('error');
    });

    it('the string value is left untouched after a rejected HSET', async () => {
      await sendCommand(socket, ['SET', 'foo', 'bar']);
      await sendCommand(socket, ['HSET', 'foo', 'field1', 'a']);
      expect(await sendCommand(socket, ['GET', 'foo'])).toEqual(bulkString('bar'));
    });
  });

  it('runs a realistic hash command sequence end to end', async () => {
    expect(await sendCommand(socket, ['HSET', 'user:1', 'name', 'anas'])).toEqual(integer(1));
    expect(await sendCommand(socket, ['HSET', 'user:1', 'age', '30'])).toEqual(integer(1));
    expect(await sendCommand(socket, ['HLEN', 'user:1'])).toEqual(integer(2));
    expect(await sendCommand(socket, ['HEXISTS', 'user:1', 'age'])).toEqual(integer(1));
    expect(await sendCommand(socket, ['HDEL', 'user:1', 'age'])).toEqual(integer(1));
    expect(await sendCommand(socket, ['HGETALL', 'user:1'])).toEqual(
      array([bulkString('name'), bulkString('anas')]),
    );
  });
});
