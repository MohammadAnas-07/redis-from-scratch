// Integration tests: spin up a real TcpServer (wired to the real dispatcher
// + a fresh DataStore, exactly like src/index.ts does) on an ephemeral port
// and talk to it over an actual TCP socket, the same way a real client
// would. These tests focus on transport/connection-lifecycle behavior;
// full command semantics are covered in test/integration/coreCommands.test.ts.
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatch } from '../../src/commands/dispatcher.js';
import { TcpServer } from '../../src/server/tcpServer.js';
import { DataStore } from '../../src/store/dataStore.js';

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    // A server-side destroy() during teardown can surface as ECONNRESET on
    // the client; swallow it here so it doesn't crash the test process as
    // an unhandled error event.
    socket.on('error', () => {});
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function once(emitter: net.Socket, event: string): Promise<Buffer> {
  return new Promise((resolve) => emitter.once(event, resolve));
}

function getPort(server: TcpServer): number {
  const address = server.address;
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to have a bound AddressInfo');
  }
  return address.port;
}

describe('TcpServer', () => {
  let server: TcpServer;
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
  });

  afterEach(async () => {
    await server.close();
  });

  it('accepts a client connection', async () => {
    const socket = await connect(port);
    expect(socket.readyState).toBe('open');
    expect(server.connectionCount).toBe(1);
    socket.destroy();
  });

  it('accepts multiple concurrent client connections', async () => {
    const sockets = await Promise.all([connect(port), connect(port), connect(port)]);
    expect(server.connectionCount).toBe(3);
    for (const socket of sockets) socket.destroy();
  });

  it('parses a RESP command off the wire and replies with an encoded RESP value', async () => {
    const socket = await connect(port);
    const received = once(socket, 'data');
    // PING as a RESP array of bulk strings: *1\r\n$4\r\nPING\r\n
    socket.write('*1\r\n$4\r\nPING\r\n');
    const data = await received;
    expect(data.toString('utf8')).toBe('+PONG\r\n');
    socket.destroy();
  });

  it('handles each concurrent client independently', async () => {
    const [a, b] = await Promise.all([connect(port), connect(port)]);
    const aData = once(a, 'data');
    const bData = once(b, 'data');
    // PING <message> replies with that message as a bulk string.
    a.write('*2\r\n$4\r\nPING\r\n$6\r\nfrom-a\r\n');
    b.write('*2\r\n$4\r\nPING\r\n$6\r\nfrom-b\r\n');
    expect((await aData).toString('utf8')).toBe('$6\r\nfrom-a\r\n');
    expect((await bData).toString('utf8')).toBe('$6\r\nfrom-b\r\n');
    a.destroy();
    b.destroy();
  });

  it('cleans up server-side state when a client disconnects', async () => {
    const socket = await connect(port);
    expect(server.connectionCount).toBe(1);

    const closed = once(socket, 'close');
    socket.end();
    await closed;

    // Give the server's 'close' handler a tick to run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(server.connectionCount).toBe(0);

    // The server should still be accepting new connections afterwards.
    const socket2 = await connect(port);
    expect(socket2.readyState).toBe('open');
    socket2.destroy();
  });

  it('does not crash when a client resets the connection', async () => {
    const socket = await connect(port);
    if (socket.resetAndDestroy) {
      socket.resetAndDestroy();
    } else {
      socket.destroy();
    }

    // Server should remain usable.
    await new Promise((resolve) => setImmediate(resolve));
    const socket2 = await connect(port);
    expect(socket2.readyState).toBe('open');
    socket2.destroy();
  });

  it('closes all open sockets when the server closes', async () => {
    const socket = await connect(port);
    const closed = once(socket, 'close');
    await server.close();
    await closed;
    expect(server.connectionCount).toBe(0);
  });

  it('sends a RESP protocol error and closes the connection on malformed input', async () => {
    const socket = await connect(port);
    const received = once(socket, 'data');
    const closed = once(socket, 'close');
    socket.write('*1\r\n$4\r\nPING\r\nGARBAGE-NOT-RESP');
    const data = await received;
    expect(data.toString('utf8')).toMatch(/^-ERR Protocol error:/);
    await closed;
  });
});
