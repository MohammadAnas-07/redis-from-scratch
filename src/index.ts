// Entry point: reads config and boots the TCP server.
import { dispatch, isWriteCommand, type DispatchContext } from './commands/dispatcher.js';
import { loadConfig } from './config/config.js';
import { ExpiryEngine } from './expiry/expiryEngine.js';
import { AofLog } from './persistence/aof.js';
import { loadPersistedState, Snapshot } from './persistence/snapshot.js';
import { SnapshotScheduler } from './persistence/snapshotScheduler.js';
import { type RespValue } from './protocol/respTypes.js';
import { TcpServer } from './server/tcpServer.js';
import { DataStore } from './store/dataStore.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new DataStore();
  const expiryEngine = new ExpiryEngine(store);
  const aofLog = new AofLog(config.aofPath, (message) => console.log(`[aof] ${message}`));
  const snapshot = new Snapshot(config.snapshotPath, (message) =>
    console.log(`[snapshot] ${message}`),
  );
  const snapshotScheduler = new SnapshotScheduler(store, snapshot, {
    writeThreshold: config.snapshotWriteThreshold,
    intervalMs: config.snapshotIntervalMs,
  });

  // Rebuild in-memory state from disk before accepting any connections.
  // Precedence: the snapshot wins only if it exists and the AOF is
  // missing or older; otherwise the AOF (if present) is replayed. See
  // ARCHITECTURE.md and src/persistence/snapshot.ts for the full rule.
  const source = loadPersistedState(store, snapshot, aofLog, (request) => {
    dispatch(store, request);
  });
  console.log(`[startup] restored state from: ${source}`);

  const dispatchContext: DispatchContext = {
    save: (s) => snapshot.save(s),
  };

  const dispatchAndPersist = (request: RespValue): RespValue => {
    const reply = dispatch(store, request, dispatchContext);
    if (reply.type !== 'error' && isWriteCommand(request)) {
      aofLog.append(request);
      snapshotScheduler.recordWrite();
    }
    return reply;
  };

  const server = new TcpServer({
    port: config.port,
    log: (message) => console.log(`[tcp] ${message}`),
    dispatch: dispatchAndPersist,
  });

  expiryEngine.start();
  snapshotScheduler.start();
  await server.listen();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`received ${signal}, closing connections and shutting down...`);
    expiryEngine.stop();
    snapshotScheduler.stop();
    server
      .close()
      .then(() => {
        console.log('shutdown complete');
        process.exit(0);
      })
      .catch((err: unknown) => {
        console.error('error during shutdown', err);
        process.exit(1);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('fatal error starting server', err);
  process.exit(1);
});
