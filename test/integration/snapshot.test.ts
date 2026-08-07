// Integration tests: real TcpServer, real dispatcher, real DataStore, real
// Snapshot/AofLog on real temp files — the SAVE command over a real
// socket, and the AOF-vs-snapshot precedence rule proven across a
// simulated restart (two independent server instances sharing only the
// files on disk, same approach as test/integration/persistence.test.ts).
import { utimesSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatch, isWriteCommand, type DispatchContext } from '../../src/commands/dispatcher.js';
import { AofLog } from '../../src/persistence/aof.js';
import { loadPersistedState, Snapshot } from '../../src/persistence/snapshot.js';
import { SnapshotScheduler } from '../../src/persistence/snapshotScheduler.js';
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

function setMtime(filePath: string, msSinceEpoch: number): void {
  const date = new Date(msSinceEpoch);
  utimesSync(filePath, date, date);
}

/** Boots one "server process" wired the same way src/index.ts does: replay/load, then serve, appending writes to the AOF and wiring SAVE to the snapshot. */
async function bootServer(
  aofPath: string,
  snapshotPath: string,
): Promise<{ store: DataStore; server: TcpServer; socket: net.Socket; source: string }> {
  const store = new DataStore();
  const aofLog = new AofLog(aofPath);
  const snapshot = new Snapshot(snapshotPath);
  const scheduler = new SnapshotScheduler(store, snapshot, {
    writeThreshold: null,
    intervalMs: null,
  });

  const source = loadPersistedState(store, snapshot, aofLog, (request) => {
    dispatch(store, request);
  });

  const context: DispatchContext = { save: (s) => snapshot.save(s) };

  const server = new TcpServer({
    port: 0,
    host: '127.0.0.1',
    dispatch: (request) => {
      const reply = dispatch(store, request, context);
      if (reply.type !== 'error' && isWriteCommand(request)) {
        aofLog.append(request);
        scheduler.recordWrite();
      }
      return reply;
    },
  });

  await server.listen();
  const socket = await connect(getPort(server));
  return { store, server, socket, source };
}

describe('SAVE and snapshot precedence (end-to-end)', () => {
  let dir: string;
  let aofPath: string;
  let snapshotPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'snapshot-integration-'));
    aofPath = join(dir, 'appendonly.aof');
    snapshotPath = join(dir, 'dump.snapshot');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('SAVE serializes the current dataset to the snapshot file', async () => {
    const { socket, server } = await bootServer(aofPath, snapshotPath);
    try {
      await sendCommand(socket, ['SET', 'foo', 'bar']);
      await sendCommand(socket, ['RPUSH', 'mylist', 'a', 'b']);

      expect(await sendCommand(socket, ['SAVE'])).toEqual({ type: 'simple', value: 'OK' });

      const snapshot = new Snapshot(snapshotPath);
      expect(snapshot.exists()).toBe(true);

      const restored = new DataStore();
      snapshot.load(restored);
      expect(restored.get('foo')).toBe('bar');
      expect(restored.lrange('mylist', 0, -1)).toEqual(['a', 'b']);
    } finally {
      socket.destroy();
      await server.close();
    }
  });

  it('loads from the snapshot on restart when the AOF is missing (SAVE then AOF cleared)', async () => {
    const first = await bootServer(aofPath, snapshotPath);
    await sendCommand(first.socket, ['SET', 'foo', 'bar']);
    await sendCommand(first.socket, ['SAVE']);
    first.socket.destroy();
    await first.server.close();

    rmSync(aofPath); // simulate AOF disabled / removed, snapshot is all that's left

    const second = await bootServer(aofPath, snapshotPath);
    try {
      expect(second.source).toBe('snapshot');
      expect(await sendCommand(second.socket, ['GET', 'foo'])).toEqual(bulkString('bar'));
    } finally {
      second.socket.destroy();
      await second.server.close();
    }
  });

  it('prefers the AOF on restart when it is newer than the snapshot (writes after the last SAVE are not lost)', async () => {
    const first = await bootServer(aofPath, snapshotPath);
    await sendCommand(first.socket, ['SET', 'foo', 'v1']);
    await sendCommand(first.socket, ['SAVE']);
    setMtime(snapshotPath, 1_000_000);

    // A write after the snapshot — only in the AOF.
    await sendCommand(first.socket, ['SET', 'foo', 'v2']);
    setMtime(aofPath, 2_000_000);

    first.socket.destroy();
    await first.server.close();

    const second = await bootServer(aofPath, snapshotPath);
    try {
      expect(second.source).toBe('aof');
      // The AOF replay includes both writes in order, so v2 wins — proving
      // the newer AOF was used instead of the stale snapshot.
      expect(await sendCommand(second.socket, ['GET', 'foo'])).toEqual(bulkString('v2'));
    } finally {
      second.socket.destroy();
      await second.server.close();
    }
  });

  it('prefers the snapshot on restart when it is newer than the AOF', async () => {
    const first = await bootServer(aofPath, snapshotPath);
    // Both AOF-writing commands happen first, then the AOF's mtime is
    // frozen old — appendFileSync would otherwise bump it back to "now"
    // on any later write, defeating the point of freezing it.
    await sendCommand(first.socket, ['SET', 'foo', 'v1']);
    await sendCommand(first.socket, ['SET', 'foo', 'v2']);
    setMtime(aofPath, 1_000_000);

    await sendCommand(first.socket, ['SAVE']); // writes the snapshot only, doesn't touch the AOF
    setMtime(snapshotPath, 2_000_000);

    first.socket.destroy();
    await first.server.close();

    const second = await bootServer(aofPath, snapshotPath);
    try {
      expect(second.source).toBe('snapshot');
      expect(await sendCommand(second.socket, ['GET', 'foo'])).toEqual(bulkString('v2'));
    } finally {
      second.socket.destroy();
      await second.server.close();
    }
  });

  it('starts empty when neither an AOF nor a snapshot exists', async () => {
    const { socket, server, source } = await bootServer(aofPath, snapshotPath);
    try {
      expect(source).toBe('none');
      expect(await sendCommand(socket, ['GET', 'foo'])).toEqual(bulkString(null));
    } finally {
      socket.destroy();
      await server.close();
    }
  });

  it('the background write-count trigger saves automatically without an explicit SAVE', async () => {
    const store = new DataStore();
    const aofLog = new AofLog(aofPath);
    const snapshot = new Snapshot(snapshotPath);
    const scheduler = new SnapshotScheduler(store, snapshot, {
      writeThreshold: 2,
      intervalMs: null,
    });
    const context: DispatchContext = { save: (s) => snapshot.save(s) };

    const server = new TcpServer({
      port: 0,
      host: '127.0.0.1',
      dispatch: (request) => {
        const reply = dispatch(store, request, context);
        if (reply.type !== 'error' && isWriteCommand(request)) {
          aofLog.append(request);
          scheduler.recordWrite();
        }
        return reply;
      },
    });
    await server.listen();
    const socket = await connect(getPort(server));

    try {
      expect(snapshot.exists()).toBe(false);
      await sendCommand(socket, ['SET', 'a', '1']);
      expect(snapshot.exists()).toBe(false); // 1 of 2 writes
      await sendCommand(socket, ['SET', 'b', '2']);
      expect(snapshot.exists()).toBe(true); // 2nd write triggers the auto-save
      expect(await sendCommand(socket, ['EXISTS', 'a'])).toEqual(integer(1));
    } finally {
      socket.destroy();
      await server.close();
    }
  });
});
