// Entry point: reads config and boots the TCP server.
import { dispatch } from './commands/dispatcher.js';
import { loadConfig } from './config/config.js';
import { ExpiryEngine } from './expiry/expiryEngine.js';
import { TcpServer } from './server/tcpServer.js';
import { DataStore } from './store/dataStore.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new DataStore();
  const expiryEngine = new ExpiryEngine(store);
  const server = new TcpServer({
    port: config.port,
    log: (message) => console.log(`[tcp] ${message}`),
    dispatch: (request) => dispatch(store, request),
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
