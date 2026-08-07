// Point-in-time full-dataset snapshot dump/load.
//
// A SAVE command (and the background save trigger, SnapshotScheduler)
// call Snapshot.save() to serialize the whole DataStore to a JSON file
// on disk; startup calls loadPersistedState() to decide whether to
// restore from that file or replay the AOF instead. Our own simplified
// format — not RDB-compatible (see ARCHITECTURE.md non-goals).
//
// Precedence rule at startup (also documented in ARCHITECTURE.md): load
// the snapshot only if it exists and the AOF either doesn't exist or is
// older than the snapshot; otherwise replay the AOF (if it exists). If
// neither exists, the store just starts empty. This is a simplified
// single-mtime-comparison version of the general "prefer the most
// recently written source, with AOF favored on ties/absence" idea —
// nothing like real Redis's separate persistence-mode configuration.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type RespValue } from '../protocol/respTypes.js';
import { DataStore, type SerializedEntry } from '../store/dataStore.js';
import { type AofLog } from './aof.js';

export type Logger = (message: string) => void;

interface SnapshotFile {
  version: 1;
  savedAt: number;
  entries: SerializedEntry[];
}

export class Snapshot {
  private readonly filePath: string;
  private readonly log: Logger;

  constructor(filePath: string, log: Logger = () => {}) {
    this.filePath = filePath;
    this.log = log;
  }

  /** Serializes the entire store to the snapshot file, overwriting any previous one, creating the parent directory as needed. */
  save(store: DataStore): void {
    const dir = dirname(this.filePath);
    if (dir !== '.') {
      mkdirSync(dir, { recursive: true });
    }

    const payload: SnapshotFile = {
      version: 1,
      savedAt: Date.now(),
      entries: store.dumpAll(),
    };
    writeFileSync(this.filePath, JSON.stringify(payload));
  }

  /**
   * Loads the snapshot file into `store`, if it exists and parses
   * cleanly. A missing or corrupted file is logged (for the corrupted
   * case) and treated as "nothing to load" rather than thrown — a bad
   * snapshot shouldn't take the whole server down at startup any more
   * than a bad AOF tail does. Returns whether anything was loaded.
   */
  load(store: DataStore): boolean {
    if (!existsSync(this.filePath)) return false;

    let payload: SnapshotFile;
    try {
      payload = JSON.parse(readFileSync(this.filePath, 'utf8')) as SnapshotFile;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log(`Snapshot: could not parse ${this.filePath} (${reason}) — ignoring it`);
      return false;
    }

    store.restoreAll(payload.entries);
    this.log(`Snapshot: restored ${payload.entries.length} key(s) from ${this.filePath}`);
    return true;
  }

  /** Whether a snapshot file currently exists on disk. */
  exists(): boolean {
    return existsSync(this.filePath);
  }

  /** Last-modified time of the snapshot file in ms since epoch, or null if it doesn't exist. */
  mtimeMs(): number | null {
    if (!existsSync(this.filePath)) return null;
    return statSync(this.filePath).mtimeMs;
  }
}

export type PersistedSource = 'snapshot' | 'aof' | 'none';

/**
 * Decides, at startup, whether to load from `snapshot` or replay
 * `aofLog`, and does it. See the module-level precedence rule above.
 * `applyAofCommand` is typically `(request) => dispatch(store, request)`.
 */
export function loadPersistedState(
  store: DataStore,
  snapshot: Snapshot,
  aofLog: AofLog,
  applyAofCommand: (request: RespValue) => void,
): PersistedSource {
  const snapshotMtime = snapshot.mtimeMs();
  const aofMtime = aofLog.mtimeMs();

  if (snapshotMtime !== null && (aofMtime === null || aofMtime < snapshotMtime)) {
    snapshot.load(store);
    return 'snapshot';
  }

  if (aofMtime !== null) {
    aofLog.replay(applyAofCommand);
    return 'aof';
  }

  return 'none';
}
