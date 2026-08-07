import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Snapshot } from '../../../src/persistence/snapshot.js';
import { SnapshotScheduler } from '../../../src/persistence/snapshotScheduler.js';
import { DataStore } from '../../../src/store/dataStore.js';

describe('SnapshotScheduler', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'snapshot-scheduler-test-'));
    filePath = join(dir, 'dump.snapshot');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('write-count trigger', () => {
    it('saves once the write threshold is reached', () => {
      const store = new DataStore();
      const snapshot = new Snapshot(filePath);
      const scheduler = new SnapshotScheduler(store, snapshot, {
        writeThreshold: 3,
        intervalMs: null,
      });

      store.set('foo', 'bar');
      scheduler.recordWrite();
      scheduler.recordWrite();
      expect(snapshot.exists()).toBe(false); // 2 of 3 — not yet

      scheduler.recordWrite();
      expect(snapshot.exists()).toBe(true); // 3rd write triggers a save
    });

    it('resets the counter after a threshold-triggered save', () => {
      const store = new DataStore();
      const snapshot = new Snapshot(filePath);
      const saveSpy = vi.spyOn(snapshot, 'save');
      const scheduler = new SnapshotScheduler(store, snapshot, {
        writeThreshold: 2,
        intervalMs: null,
      });

      scheduler.recordWrite();
      scheduler.recordWrite(); // save #1
      scheduler.recordWrite();
      expect(saveSpy).toHaveBeenCalledTimes(1);
      scheduler.recordWrite(); // save #2
      expect(saveSpy).toHaveBeenCalledTimes(2);
    });

    it('does not save at all when the write trigger is disabled', () => {
      const store = new DataStore();
      const snapshot = new Snapshot(filePath);
      const scheduler = new SnapshotScheduler(store, snapshot, {
        writeThreshold: null,
        intervalMs: null,
      });

      for (let i = 0; i < 1000; i++) scheduler.recordWrite();
      expect(snapshot.exists()).toBe(false);
    });

    it('captures the store contents at save time', () => {
      const store = new DataStore();
      const snapshot = new Snapshot(filePath);
      const scheduler = new SnapshotScheduler(store, snapshot, {
        writeThreshold: 1,
        intervalMs: null,
      });

      store.set('foo', 'bar');
      scheduler.recordWrite();

      const restored = new DataStore();
      new Snapshot(filePath).load(restored);
      expect(restored.get('foo')).toBe('bar');
    });
  });

  describe('interval trigger', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('saves on the configured interval', () => {
      const store = new DataStore();
      store.set('foo', 'bar');
      const snapshot = new Snapshot(filePath);
      const scheduler = new SnapshotScheduler(store, snapshot, {
        writeThreshold: null,
        intervalMs: 100,
      });

      scheduler.start();
      expect(snapshot.exists()).toBe(false);

      vi.advanceTimersByTime(100);
      expect(snapshot.exists()).toBe(true);

      scheduler.stop();
    });

    it('does not save on an interval when the interval trigger is disabled', () => {
      const store = new DataStore();
      const snapshot = new Snapshot(filePath);
      const scheduler = new SnapshotScheduler(store, snapshot, {
        writeThreshold: null,
        intervalMs: null,
      });

      scheduler.start();
      vi.advanceTimersByTime(1_000_000);
      expect(snapshot.exists()).toBe(false);
    });

    it('stop() prevents further interval saves', () => {
      const store = new DataStore();
      const snapshot = new Snapshot(filePath);
      const saveSpy = vi.spyOn(snapshot, 'save');
      const scheduler = new SnapshotScheduler(store, snapshot, {
        writeThreshold: null,
        intervalMs: 50,
      });

      scheduler.start();
      vi.advanceTimersByTime(50);
      expect(saveSpy).toHaveBeenCalledTimes(1);

      scheduler.stop();
      vi.advanceTimersByTime(500);
      expect(saveSpy).toHaveBeenCalledTimes(1); // no further calls
    });

    it('start() is idempotent — a second call does not create a second interval', () => {
      const store = new DataStore();
      const snapshot = new Snapshot(filePath);
      const saveSpy = vi.spyOn(snapshot, 'save');
      const scheduler = new SnapshotScheduler(store, snapshot, {
        writeThreshold: null,
        intervalMs: 10,
      });

      scheduler.start();
      scheduler.start();
      vi.advanceTimersByTime(10);

      expect(saveSpy).toHaveBeenCalledTimes(1);
      scheduler.stop();
    });

    it('stop() is safe to call when never started', () => {
      const scheduler = new SnapshotScheduler(new DataStore(), new Snapshot(filePath));
      expect(() => scheduler.stop()).not.toThrow();
    });
  });

  describe('saveNow', () => {
    it('saves immediately regardless of triggers', () => {
      const store = new DataStore();
      store.set('foo', 'bar');
      const snapshot = new Snapshot(filePath);
      const scheduler = new SnapshotScheduler(store, snapshot, {
        writeThreshold: null,
        intervalMs: null,
      });

      scheduler.saveNow();
      expect(snapshot.exists()).toBe(true);
    });

    it('resets the write counter', () => {
      const store = new DataStore();
      const snapshot = new Snapshot(filePath);
      const saveSpy = vi.spyOn(snapshot, 'save');
      const scheduler = new SnapshotScheduler(store, snapshot, {
        writeThreshold: 3,
        intervalMs: null,
      });

      scheduler.recordWrite();
      scheduler.recordWrite();
      scheduler.saveNow(); // manual save resets the counter
      expect(saveSpy).toHaveBeenCalledTimes(1);

      scheduler.recordWrite();
      scheduler.recordWrite();
      expect(saveSpy).toHaveBeenCalledTimes(1); // still only 2 writes since reset

      scheduler.recordWrite();
      expect(saveSpy).toHaveBeenCalledTimes(2); // 3rd write since reset triggers again
    });
  });
});
