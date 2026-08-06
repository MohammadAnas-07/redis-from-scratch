// Integration tests: real TcpServer, real dispatcher, real DataStore --
// EXPIRE/PEXPIRE/TTL/PTTL/PERSIST over a real socket, plus a dedicated
// suite proving passive expiry works correctly even though no active
// ExpiryEngine sweep is ever created or started anywhere in this file.
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('expiry commands (end-to-end over a real socket)', () => {
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
    // No ExpiryEngine is created anywhere in this suite. Every case here
    // relies solely on DataStore's passive (on-access) expiry.
    await server.listen();
    port = getPort(server);
    socket = await connect(port);
  });

  afterEach(async () => {
    socket.destroy();
    await server.close();
  });

  it('EXPIRE sets a TTL and TTL reports it back in seconds', async () => {
    await sendCommand(socket, ['SET', 'foo', 'bar']);
    expect(await sendCommand(socket, ['EXPIRE', 'foo', '100'])).toEqual(integer(1));
    expect(await sendCommand(socket, ['TTL', 'foo'])).toEqual(integer(100));
  });

  it('EXPIRE on a missing key returns 0', async () => {
    expect(await sendCommand(socket, ['EXPIRE', 'missing', '100'])).toEqual(integer(0));
  });

  it('PEXPIRE and PTTL round-trip in milliseconds', async () => {
    await sendCommand(socket, ['SET', 'foo', 'bar']);
    expect(await sendCommand(socket, ['PEXPIRE', 'foo', '60000'])).toEqual(integer(1));
    expect(await sendCommand(socket, ['PTTL', 'foo'])).toEqual(integer(60000));
  });

  it('TTL/PTTL return -2 for a missing key and -1 for a key with no expiry', async () => {
    expect(await sendCommand(socket, ['TTL', 'missing'])).toEqual(integer(-2));
    expect(await sendCommand(socket, ['PTTL', 'missing'])).toEqual(integer(-2));
    await sendCommand(socket, ['SET', 'foo', 'bar']);
    expect(await sendCommand(socket, ['TTL', 'foo'])).toEqual(integer(-1));
    expect(await sendCommand(socket, ['PTTL', 'foo'])).toEqual(integer(-1));
  });

  it('PERSIST removes an expiry and TTL reflects it afterwards', async () => {
    await sendCommand(socket, ['SET', 'foo', 'bar', 'EX', '100']);
    expect(await sendCommand(socket, ['PERSIST', 'foo'])).toEqual(integer(1));
    expect(await sendCommand(socket, ['TTL', 'foo'])).toEqual(integer(-1));
  });

  it('PERSIST returns 0 when there is nothing to remove', async () => {
    await sendCommand(socket, ['SET', 'foo', 'bar']);
    expect(await sendCommand(socket, ['PERSIST', 'foo'])).toEqual(integer(0));
  });

  it('EXPIRE rejects a non-integer amount', async () => {
    await sendCommand(socket, ['SET', 'foo', 'bar']);
    const reply = await sendCommand(socket, ['EXPIRE', 'foo', 'soon']);
    expect(reply.type).toBe('error');
  });

  describe('passive expiry (no active sweep running anywhere in this suite)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('GET returns a nil bulk string for a key past its TTL', async () => {
      await sendCommand(socket, ['SET', 'foo', 'bar', 'PX', '50']);
      vi.advanceTimersByTime(100);
      expect(await sendCommand(socket, ['GET', 'foo'])).toEqual(bulkString(null));
    });

    it('EXISTS does not count an expired key', async () => {
      await sendCommand(socket, ['SET', 'foo', 'bar', 'PX', '50']);
      vi.advanceTimersByTime(100);
      expect(await sendCommand(socket, ['EXISTS', 'foo'])).toEqual(integer(0));
    });

    it('TTL reports -2 (as if missing) for a key that has passively expired', async () => {
      await sendCommand(socket, ['SET', 'foo', 'bar', 'PX', '50']);
      vi.advanceTimersByTime(100);
      expect(await sendCommand(socket, ['TTL', 'foo'])).toEqual(integer(-2));
    });

    it('DEL does not count a passively-expired key as removed', async () => {
      await sendCommand(socket, ['SET', 'foo', 'bar', 'PX', '50']);
      vi.advanceTimersByTime(100);
      expect(await sendCommand(socket, ['DEL', 'foo'])).toEqual(integer(0));
    });

    it('a passively-expired list key behaves as if it does not exist', async () => {
      await sendCommand(socket, ['RPUSH', 'mylist', 'a', 'b']);
      await sendCommand(socket, ['PEXPIRE', 'mylist', '50']);
      vi.advanceTimersByTime(100);
      expect(await sendCommand(socket, ['LRANGE', 'mylist', '0', '-1'])).toEqual(array([]));
      expect(await sendCommand(socket, ['LLEN', 'mylist'])).toEqual(integer(0));
    });

    it('re-SET after passive expiry behaves like setting a brand-new key', async () => {
      await sendCommand(socket, ['SET', 'foo', 'old', 'PX', '50']);
      vi.advanceTimersByTime(100);
      await sendCommand(socket, ['SET', 'foo', 'new']);
      expect(await sendCommand(socket, ['GET', 'foo'])).toEqual(bulkString('new'));
      expect(await sendCommand(socket, ['TTL', 'foo'])).toEqual(integer(-1));
    });
  });
});
