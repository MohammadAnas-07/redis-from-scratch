// Entry point: reads config and boots the TCP server.
import { dispatch, isWriteCommand } from './commands/dispatcher.js';
import { loadConfig } from './config/config.js';
import { ExpiryEngine } from './expiry/expiryEngine.js';
import { AofLog } from './persistence/aof.js';
import { type RespValue } from './protocol/respTypes.js';
import { TcpServer } from './server/tcpServer.js';
import { DataStore } from './store/dataStore.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new DataStore();
  const expiryEngine = new ExpiryEngine(store);
  const aofLog = new AofLog(config.aofPath, (message) => console.log(`[aof] ${message}`));

  // Rebuild in-memory state from disk before accepting any connections.
  aofLog.replay((request) => {
    dispatch(store, request);
  });

  const dispatchAndPersist = (request: RespValue): RespValue => {
    const reply = dispatch(store, request);
    if (reply.type !== 'error' && isWriteCommand(request)) {
      aofLog.append(request);
    }
    return reply;
  };

  const server = new TcpServer({
    port: config.port,
    log: (message) => console.log(`[tcp] ${message}`),
    dispatch: dispatchAndPersist,
  });

  expiryEngine.start();
  await server.listen();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`received ${signal}, closing connections and shutting down...`);
    expiryEngine.stop();
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
