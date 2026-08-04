// Owns the net.Server, connection lifecycle, and socket <-> parser/dispatcher wiring.
//
// For this chunk there is no RESP parsing yet: incoming bytes are logged and
// echoed straight back. The parser/dispatcher will be wired in here later.
import net from 'node:net';

export type Logger = (message: string) => void;

export interface TcpServerOptions {
  /** Port to listen on. Use 0 to let the OS assign an ephemeral port (tests). */
  port: number;
  host?: string;
  log?: Logger;
}

export class TcpServer {
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private readonly port: number;
  private readonly host: string;
  private readonly log: Logger;

  constructor(options: TcpServerOptions) {
    this.port = options.port;
    this.host = options.host ?? '0.0.0.0';
    this.log = options.log ?? (() => {});

    this.server = net.createServer((socket) => this.handleConnection(socket));

    // Permanent listener so a later server-level error (e.g. an unexpected
    // EMFILE) is logged instead of crashing the process as an unhandled
    // 'error' event.
    this.server.on('error', (err) => {
      this.log(`server error: ${(err as Error).message}`);
    });
  }

  private handleConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    this.log(`client connected: ${remote}`);

    socket.on('data', (data: Buffer) => {
      this.log(`received ${data.length} bytes from ${remote}: ${data.toString('utf8')}`);
      socket.write(data);
    });

    socket.on('close', () => {
      this.sockets.delete(socket);
      this.log(`client disconnected: ${remote}`);
    });

    // Without this handler, a client-side reset (ECONNRESET) or similar
    // socket error would be an unhandled 'error' event and crash the process.
    socket.on('error', (err) => {
      this.log(`socket error from ${remote}: ${err.message}`);
    });
  }

  /** Starts listening. Resolves once bound, rejects on bind failure (e.g. EADDRINUSE). */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.server.once('error', onError);

      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', onError);
        this.log(`listening on ${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  /**
   * Closes all open client connections and stops the server. Safe to call
   * more than once. Used for both graceful shutdown (SIGINT/SIGTERM) and
   * test teardown.
   */
  close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();

    if (!this.server.listening) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** The bound address, or null if not currently listening. */
  get address(): net.AddressInfo | string | null {
    return this.server.address();
  }

  /** Number of currently connected clients. */
  get connectionCount(): number {
    return this.sockets.size;
  }
}
