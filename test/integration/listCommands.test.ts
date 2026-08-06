// Integration tests: real TcpServer, real dispatcher, real DataStore — the
// exact wiring src/index.ts does — driven over a real TCP socket with real
// RESP-encoded LPUSH/RPUSH/LPOP/RPOP/LRANGE/LLEN requests, asserting on
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

describe('list commands (end-to-end over a real socket)', () => {
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

  it('LPUSH then LRANGE returns elements head-first', async () => {
    expect(await sendCommand(socket, ['LPUSH', 'mylist', 'a', 'b', 'c'])).toEqual(integer(3));
    expect(await sendCommand(socket, ['LRANGE', 'mylist', '0', '-1'])).toEqual(
      array([bulkString('c'), bulkString('b'), bulkString('a')]),
    );
  });

  it('RPUSH then LRANGE returns elements in insertion order', async () => {
    expect(await sendCommand(socket, ['RPUSH', 'mylist', 'a', 'b', 'c'])).toEqual(integer(3));
    expect(await sendCommand(socket, ['LRANGE', 'mylist', '0', '-1'])).toEqual(
      array([bulkString('a'), bulkString('b'), bulkString('c')]),
    );
  });

  it('LPOP and RPOP remove from the correct ends', async () => {
    await sendCommand(socket, ['RPUSH', 'mylist', 'a', 'b', 'c']);
    expect(await sendCommand(socket, ['LPOP', 'mylist'])).toEqual(bulkString('a'));
    expect(await sendCommand(socket, ['RPOP', 'mylist'])).toEqual(bulkString('c'));
    expect(await sendCommand(socket, ['LRANGE', 'mylist', '0', '-1'])).toEqual(
      array([bulkString('b')]),
    );
  });

  it('LPOP on a missing key returns a null bulk string', async () => {
    expect(await sendCommand(socket, ['LPOP', 'nope'])).toEqual(bulkString(null));
  });

  it('LLEN reflects the current list length, including 0 for a missing key', async () => {
    expect(await sendCommand(socket, ['LLEN', 'mylist'])).toEqual(integer(0));
    await sendCommand(socket, ['RPUSH', 'mylist', 'a', 'b']);
    expect(await sendCommand(socket, ['LLEN', 'mylist'])).toEqual(integer(2));
  });

  it('a list key is removed once emptied by LPOP/RPOP', async () => {
    await sendCommand(socket, ['RPUSH', 'mylist', 'only']);
    await sendCommand(socket, ['LPOP', 'mylist']);
    expect(await sendCommand(socket, ['EXISTS', 'mylist'])).toEqual(integer(0));
  });

  describe('WRONGTYPE errors', () => {
    it('LPUSH on a key holding a string returns a RESP error over the wire', async () => {
      await sendCommand(socket, ['SET', 'foo', 'bar']);
      const reply = await sendCommand(socket, ['LPUSH', 'foo', 'x']);
      expect(reply).toEqual({
        type: 'error',
        value: 'WRONGTYPE Operation against a key holding the wrong kind of value',
      });
    });

    it('GET on a key holding a list returns a RESP error over the wire', async () => {
      await sendCommand(socket, ['RPUSH', 'mylist', 'a']);
      const reply = await sendCommand(socket, ['GET', 'mylist']);
      expect(reply.type).toBe('error');
    });

    it('the string value is left untouched after a rejected LPUSH', async () => {
      await sendCommand(socket, ['SET', 'foo', 'bar']);
      await sendCommand(socket, ['LPUSH', 'foo', 'x']);
      expect(await sendCommand(socket, ['GET', 'foo'])).toEqual(bulkString('bar'));
    });
  });

  it('runs a realistic list command sequence end to end', async () => {
    expect(await sendCommand(socket, ['RPUSH', 'queue', 'job1'])).toEqual(integer(1));
    expect(await sendCommand(socket, ['RPUSH', 'queue', 'job2', 'job3'])).toEqual(integer(3));
    expect(await sendCommand(socket, ['LLEN', 'queue'])).toEqual(integer(3));
    expect(await sendCommand(socket, ['LPOP', 'queue'])).toEqual(bulkString('job1'));
    expect(await sendCommand(socket, ['LRANGE', 'queue', '0', '-1'])).toEqual(
      array([bulkString('job2'), bulkString('job3')]),
    );
  });
});
