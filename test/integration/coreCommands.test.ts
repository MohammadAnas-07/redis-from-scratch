// Integration tests: real TcpServer, real dispatcher, real DataStore — the
// exact wiring src/index.ts does — driven over a real TCP socket with real
// RESP-encoded requests, asserting on real RESP-encoded responses.
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatch } from '../../src/commands/dispatcher.js';
import { RespParser } from '../../src/protocol/respParser.js';
import { encodeResp } from '../../src/protocol/respSerializer.js';
import {
  array,
  bulkString,
  integer,
  simpleString,
  type RespValue,
} from '../../src/protocol/respTypes.js';
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

describe('core commands (end-to-end over a real socket)', () => {
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

  describe('PING', () => {
    it('replies +PONG with no arguments', async () => {
      expect(await sendCommand(socket, ['PING'])).toEqual(simpleString('PONG'));
    });

    it('echoes its message back as a bulk string', async () => {
      expect(await sendCommand(socket, ['PING', 'hello world'])).toEqual(bulkString('hello world'));
    });
  });

  describe('SET / GET', () => {
    it('round-trips a value', async () => {
      expect(await sendCommand(socket, ['SET', 'foo', 'bar'])).toEqual(simpleString('OK'));
      expect(await sendCommand(socket, ['GET', 'foo'])).toEqual(bulkString('bar'));
    });

    it('GET on a missing key returns a null bulk string', async () => {
      expect(await sendCommand(socket, ['GET', 'nope'])).toEqual(bulkString(null));
    });

    it('accepts EX and leaves the key readable', async () => {
      expect(await sendCommand(socket, ['SET', 'foo', 'bar', 'EX', '100'])).toEqual(
        simpleString('OK'),
      );
      expect(await sendCommand(socket, ['GET', 'foo'])).toEqual(bulkString('bar'));
    });

    it('accepts PX and leaves the key readable', async () => {
      expect(await sendCommand(socket, ['SET', 'foo', 'bar', 'PX', '100000'])).toEqual(
        simpleString('OK'),
      );
      expect(await sendCommand(socket, ['GET', 'foo'])).toEqual(bulkString('bar'));
    });

    it('rejects an unsupported SET option with a RESP error', async () => {
      const reply = await sendCommand(socket, ['SET', 'foo', 'bar', 'XX', '10']);
      expect(reply.type).toBe('error');
    });
  });

  describe('DEL', () => {
    it('removes keys and reports how many were actually removed', async () => {
      await sendCommand(socket, ['SET', 'a', '1']);
      await sendCommand(socket, ['SET', 'b', '2']);
      expect(await sendCommand(socket, ['DEL', 'a', 'b', 'missing'])).toEqual(integer(2));
      expect(await sendCommand(socket, ['GET', 'a'])).toEqual(bulkString(null));
    });
  });

  describe('EXISTS', () => {
    it('counts how many of the given keys are present', async () => {
      await sendCommand(socket, ['SET', 'a', '1']);
      expect(await sendCommand(socket, ['EXISTS', 'a', 'missing'])).toEqual(integer(1));
    });
  });

  describe('errors', () => {
    it('returns a RESP error for an unknown command', async () => {
      expect(await sendCommand(socket, ['NOPE'])).toEqual({
        type: 'error',
        value: "ERR unknown command 'NOPE'",
      });
    });

    it('returns a RESP error for the wrong number of arguments', async () => {
      expect((await sendCommand(socket, ['GET'])).type).toBe('error');
    });
  });

  it('runs a realistic command sequence end to end', async () => {
    expect(await sendCommand(socket, ['SET', 'counter', '1'])).toEqual(simpleString('OK'));
    expect(await sendCommand(socket, ['EXISTS', 'counter'])).toEqual(integer(1));
    expect(await sendCommand(socket, ['GET', 'counter'])).toEqual(bulkString('1'));
    expect(await sendCommand(socket, ['DEL', 'counter'])).toEqual(integer(1));
    expect(await sendCommand(socket, ['EXISTS', 'counter'])).toEqual(integer(0));
    expect(await sendCommand(socket, ['GET', 'counter'])).toEqual(bulkString(null));
  });

  it('shares state between two concurrently connected clients', async () => {
    const socket2 = await connect(port);
    await sendCommand(socket, ['SET', 'shared', 'value']);
    expect(await sendCommand(socket2, ['GET', 'shared'])).toEqual(bulkString('value'));
    socket2.destroy();
  });

  it('replies to multiple pipelined commands sent in a single write', async () => {
    const received = new Promise<Buffer>((resolve) => socket.once('data', resolve));
    const payload = Buffer.concat([
      encodeResp(array([bulkString('SET'), bulkString('x'), bulkString('1')])),
      encodeResp(array([bulkString('GET'), bulkString('x')])),
    ]);
    socket.write(payload);
    const data = await received;
    expect(data.toString('utf8')).toBe('+OK\r\n$1\r\n1\r\n');
  });
});
