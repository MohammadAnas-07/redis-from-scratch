// Background save trigger: saves the whole dataset either after N writes
// or every M ms, whichever comes first.
//
// This is a deliberately simplified stand-in for real Redis's RDB save
// points (multiple configurable `save <seconds> <changes>` rules,
// evaluated together, backed by a forked copy-on-write child process so
// saving never blocks the main event loop). Here there's exactly one
// write-count trigger and one interval trigger, and save() itself is a
// synchronous, blocking JSON write via Snapshot — fine for the dataset
// sizes this project targets, not something you'd want under real load.
import { type DataStore } from '../store/dataStore.js';
import { type Snapshot } from './snapshot.js';

export interface SnapshotSchedulerOptions {
  /** Save automatically once this many writes have happened since the last save. Defaults to 100. Pass null to disable this trigger. */
  writeThreshold?: number | null;
  /** Also save on this interval (ms), independent of write count. Defaults to 60_000. Pass null to disable this trigger. */
  intervalMs?: number | null;
}

const DEFAULT_WRITE_THRESHOLD = 100;
const DEFAULT_INTERVAL_MS = 60_000;

export class SnapshotScheduler {
  private readonly store: DataStore;
  private readonly snapshot: Snapshot;
  private readonly writeThreshold: number | null;
  private readonly intervalMs: number | null;
  private writesSinceSave = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(store: DataStore, snapshot: Snapshot, options: SnapshotSchedulerOptions = {}) {
    this.store = store;
    this.snapshot = snapshot;
    this.writeThreshold =
      options.writeThreshold === undefined ? DEFAULT_WRITE_THRESHOLD : options.writeThreshold;
    this.intervalMs = options.intervalMs === undefined ? DEFAULT_INTERVAL_MS : options.intervalMs;
  }

  /** Call after every successful write command. Triggers an immediate save once the write threshold is reached. */
  recordWrite(): void {
    if (this.writeThreshold === null) return;
    this.writesSinceSave++;
    if (this.writesSinceSave >= this.writeThreshold) {
      this.saveNow();
    }
  }

  /** Starts the interval-based trigger. Idempotent. No-op if the interval trigger is disabled. */
  start(): void {
    if (this.intervalMs === null || this.timer !== null) return;
    this.timer = setInterval(() => this.saveNow(), this.intervalMs);
    this.timer.unref();
  }

  /** Stops the interval-based trigger. Safe to call even if it isn't running. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Saves immediately, outside either trigger, and resets the write counter. */
  saveNow(): void {
    this.snapshot.save(this.store);
    this.writesSinceSave = 0;
  }
}
