// Append-only write log and replay-on-startup persistence.
//
// Every write command is appended to disk exactly as its original
// RESP-encoded bytes (the same array-of-bulk-strings shape a client
// sent), matching how real Redis's AOF works. Replaying later means
// re-running each command through the same dispatcher used for live
// traffic, so state is rebuilt the same way it was built the first
// time — the AOF module itself never touches DataStore directly.
//
// Simplifications vs real Redis, worth calling out:
//  - Every append is a synchronous fs write (no buffering, no
//    configurable fsync policy like appendfsync always/everysec/no).
//  - No AOF rewrite/compaction — the file only ever grows.
//  - A relative EXPIRE/PEXPIRE is replayed as-is, so its TTL restarts
//    counting from replay time rather than preserving the original
//    absolute expiry (real Redis rewrites these to PEXPIREAT in the AOF
//    specifically to avoid this).
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseValue } from '../protocol/respParser.js';
import { encodeResp } from '../protocol/respSerializer.js';
import { RespProtocolError, type RespValue } from '../protocol/respTypes.js';

export type Logger = (message: string) => void;

export interface ReplayResult {
  /** How many commands were successfully replayed. */
  replayedCount: number;
  /** True if replay stopped early because of a corrupted or truncated tail. */
  truncated: boolean;
}

export class AofLog {
  private readonly filePath: string;
  private readonly log: Logger;

  constructor(filePath: string, log: Logger = () => {}) {
    this.filePath = filePath;
    this.log = log;
  }

  /** Appends one command's RESP-encoded bytes to the AOF file, creating the parent directory/file as needed. */
  append(request: RespValue): void {
    const dir = dirname(this.filePath);
    if (dir !== '.') {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(this.filePath, encodeResp(request));
  }

  /**
   * Replays every command in the AOF file by calling `applyCommand` for
   * each one, in order (typically `(request) => dispatch(store, request)`,
   * with the reply discarded). A no-op if the file doesn't exist yet.
   *
   * A corrupted or truncated tail is logged and replay stops there —
   * every valid command before it still gets applied, and this never
   * throws.
   */
  replay(applyCommand: (request: RespValue) => void): ReplayResult {
    if (!existsSync(this.filePath)) {
      return { replayedCount: 0, truncated: false };
    }

    const buffer = readFileSync(this.filePath);
    let offset = 0;
    let replayedCount = 0;
    let truncated = false;

    while (offset < buffer.length) {
      let result;
      try {
        result = parseValue(buffer, offset);
      } catch (err) {
        const reason = err instanceof RespProtocolError ? err.message : String(err);
        this.log(
          `AOF replay: corrupted command at byte offset ${offset} (${reason}) — stopping replay here, ${replayedCount} command(s) already restored`,
        );
        truncated = true;
        break;
      }

      if (result === null) {
        this.log(
          `AOF replay: incomplete/truncated command at byte offset ${offset} — stopping replay here, ${replayedCount} command(s) already restored`,
        );
        truncated = true;
        break;
      }

      applyCommand(result.value);
      offset = result.next;
      replayedCount++;
    }

    if (!truncated) {
      this.log(`AOF replay: restored ${replayedCount} command(s) from ${this.filePath}`);
    }

    return { replayedCount, truncated };
  }

  /** Last-modified time of the AOF file in ms since epoch, or null if it doesn't exist. Used to decide AOF-vs-snapshot precedence at startup (see Snapshot.loadPersistedState). */
  mtimeMs(): number | null {
    if (!existsSync(this.filePath)) return null;
    return statSync(this.filePath).mtimeMs;
  }
}
