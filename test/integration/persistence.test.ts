// Integration tests: prove state actually survives a server restart via
// the AOF, driven the same way src/index.ts wires things together (real
// TcpServer, real dispatcher, real DataStore, real AofLog on a real temp
// file) — but with two independent DataStore/TcpServer instances sharing
// only the AOF file on disk, to genuinely simulate "kill the process,
// start a new one" rather than just reusing in-memory objects.
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatch, isWriteCommand } from '../../src/commands/dispatcher.js';
import { AofLog } from '../../src/persistence/aof.js';
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

function sendCommand(socket: net.Socket, args: string[]): Promise<RespValue> {
  return new Promise((resolve) => {
    socket.once('data', (data: Buffer) => {
      const [reply] = new RespParser().push(data);
      resolve(reply);
    });
    socket.write(encodeResp(array(args.map((a) => bulkString(a)))));
  });
}

/** Boots one "server process": a fresh DataStore replayed from `aofPath`, wired to a real TcpServer. */
async function bootServer(aofPath: string): Promise<{
  store: DataStore;
  server: TcpServer;
  socket: net.Socket;
}> {
  const store = new DataStore();
  const aofLog = new AofLog(aofPath);

  // Same order as src/index.ts: replay before accepting connections.
  aofLog.replay((request) => {
    dispatch(store, request);
  });

  const server = new TcpServer({
    port: 0,
    host: '127.0.0.1',
    dispatch: (request) => {
      const reply = dispatch(store, request);
      if (reply.type !== 'error' && isWriteCommand(request)) {
        aofLog.append(request);
      }
      return reply;
    },
  });

  await server.listen();
  const socket = await connect(getPort(server));
  return { store, server, socket };
}

describe('AOF persistence (write, restart, verify restored)', () => {
  let dir: string;
  let aofPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aof-integration-'));
    aofPath = join(dir, 'appendonly.aof');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('restores string, list, hash, and set state after a simulated restart', async () => {
    // --- "first process" ---
    const first = await bootServer(aofPath);
    expect(await sendCommand(first.socket, ['SET', 'foo', 'bar'])).toEqual({
      type: 'simple',
      value: 'OK',
    });
    expect(await sendCommand(first.socket, ['RPUSH', 'mylist', 'a', 'b', 'c'])).toEqual(integer(3));
    expect(
      await sendCommand(first.socket, ['HSET', 'myhash', 'field1', 'x', 'field2', 'y']),
    ).toEqual(integer(2));
    expect(await sendCommand(first.socket, ['SADD', 'myset', 'm1', 'm2'])).toEqual(integer(2));

    first.socket.destroy();
    await first.server.close(); // "kill the process"

    // --- "restarted process" — brand-new store, same AOF file ---
    const second = await bootServer(aofPath);
    try {
      expect(await sendCommand(second.socket, ['GET', 'foo'])).toEqual(bulkString('bar'));
      expect(await sendCommand(second.socket, ['LRANGE', 'mylist', '0', '-1'])).toEqual(
        array([bulkString('a'), bulkString('b'), bulkString('c')]),
      );
      expect(await sendCommand(second.socket, ['HGET', 'myhash', 'field1'])).toEqual(
        bulkString('x'),
      );
      expect(await sendCommand(second.socket, ['SISMEMBER', 'myset', 'm1'])).toEqual(integer(1));
    } finally {
      second.socket.destroy();
      await second.server.close();
    }
  });

  it('does not resurrect a key that was deleted before the restart', async () => {
    const first = await bootServer(aofPath);
    await sendCommand(first.socket, ['SET', 'foo', 'bar']);
    await sendCommand(first.socket, ['DEL', 'foo']);
    first.socket.destroy();
    await first.server.close();

    const second = await bootServer(aofPath);
    try {
      expect(await sendCommand(second.socket, ['GET', 'foo'])).toEqual(bulkString(null));
      expect(await sendCommand(second.socket, ['EXISTS', 'foo'])).toEqual(integer(0));
    } finally {
      second.socket.destroy();
      await second.server.close();
    }
  });

  it('does not persist read-only commands or failed writes', async () => {
    const first = await bootServer(aofPath);
    await sendCommand(first.socket, ['SET', 'foo', 'bar']);
    await sendCommand(first.socket, ['GET', 'foo']); // read-only — should not be logged
    await sendCommand(first.socket, ['LPUSH', 'foo', 'x']); // WRONGTYPE — should not be logged
    first.socket.destroy();
    await first.server.close();

    const second = await bootServer(aofPath);
    try {
      // Only the one successful SET should have replayed.
      expect(await sendCommand(second.socket, ['GET', 'foo'])).toEqual(bulkString('bar'));
      expect(second.store.size).toBe(1);
    } finally {
      second.socket.destroy();
      await second.server.close();
    }
  });

  it('a key that survives an EXPIRE still has some TTL after restart', async () => {
    const first = await bootServer(aofPath);
    await sendCommand(first.socket, ['SET', 'foo', 'bar']);
    await sendCommand(first.socket, ['EXPIRE', 'foo', '3600']);
    first.socket.destroy();
    await first.server.close();

    const second = await bootServer(aofPath);
    try {
      expect(await sendCommand(second.socket, ['GET', 'foo'])).toEqual(bulkString('bar'));
      const ttlReply = await sendCommand(second.socket, ['TTL', 'foo']);
      expect(ttlReply.type).toBe('integer');
      // Not asserting an exact value: EXPIRE is replayed as a relative
      // command, so the TTL clock restarts from replay time rather than
      // preserving the original absolute expiry (documented simplification
      // vs real Redis, which persists an absolute PEXPIREAT instead).
      expect((ttlReply as { type: 'integer'; value: number }).value).toBeGreaterThan(0);
    } finally {
      second.socket.destroy();
      await second.server.close();
    }
  });

  it('replays cleanly and serves whatever was valid when the AOF gets corrupted mid-file', async () => {
    const first = await bootServer(aofPath);
    await sendCommand(first.socket, ['SET', 'a', '1']);
    await sendCommand(first.socket, ['SET', 'b', '2']);
    first.socket.destroy();
    await first.server.close();

    // Simulate a crash mid-write: valid commands followed by garbage bytes.
    appendFileSync(aofPath, Buffer.from('*not-valid-resp-at-all'));

    const second = await bootServer(aofPath);
    try {
      // Startup didn't crash, and both commands before the corruption survived.
      expect(await sendCommand(second.socket, ['GET', 'a'])).toEqual(bulkString('1'));
      expect(await sendCommand(second.socket, ['GET', 'b'])).toEqual(bulkString('2'));
    } finally {
      second.socket.destroy();
      await second.server.close();
    }
  });
});
