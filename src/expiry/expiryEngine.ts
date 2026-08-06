// TTL tracking plus passive (on-access) and active (periodic sweep) key expiry.
//
// Passive expiry lives inside DataStore itself (see getLive() there) —
// every read path lazily deletes a key the moment it notices the key's
// TTL has passed. This module is the *active* half: a small scheduler
// that periodically calls DataStore.sweepExpired() so keys nobody ever
// reads again eventually get cleaned up too, instead of sitting in
// memory forever. Each tick does a bounded amount of work (a sample of
// keys-with-a-TTL, not the whole keyspace) — see DataStore.sweepExpired
// for why that's safe to call frequently without blocking the event loop.
import type { DataStore } from '../store/dataStore.js';

export interface ExpiryEngineOptions {
  /** How often to run a sweep, in ms. Defaults to 100ms. */
  intervalMs?: number;
  /** Max number of TTL'd keys to check per sweep tick. Defaults to 20. */
  sampleSize?: number;
}

const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_SAMPLE_SIZE = 20;

export class ExpiryEngine {
  private readonly store: DataStore;
  private readonly intervalMs: number;
  private readonly sampleSize: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(store: DataStore, options: ExpiryEngineOptions = {}) {
    this.store = store;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.sampleSize = options.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  }

  /** Starts the periodic sweep. Idempotent — calling it again while already running does nothing. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.store.sweepExpired(this.sampleSize);
    }, this.intervalMs);
    // Don't let this timer alone keep the process alive (e.g. during
    // graceful shutdown or in short-lived scripts/tests).
    this.timer.unref();
  }

  /** Stops the periodic sweep. Safe to call even if it isn't running. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Runs one sweep pass immediately, outside the regular schedule. Returns how many keys were removed. Mainly useful for tests. */
  tick(): number {
    return this.store.sweepExpired(this.sampleSize);
  }
}
