import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpiryEngine } from '../../../src/expiry/expiryEngine.js';
import { DataStore } from '../../../src/store/dataStore.js';

describe('ExpiryEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('tick', () => {
    it('removes expired keys immediately, without waiting for the interval', () => {
      const store = new DataStore();
      store.set('a', '1', Date.now() + 10);
      store.set('b', '2'); // no TTL
      vi.advanceTimersByTime(20);

      const engine = new ExpiryEngine(store, { sampleSize: 10 });
      const removed = engine.tick();

      expect(removed).toBe(1);
      expect(store.size).toBe(1);
      expect(store.get('b')).toBe('2');
    });

    it('bounds work to sampleSize even when more keys are expired', () => {
      const store = new DataStore();
      for (let i = 0; i < 10; i++) {
        store.set(`k${i}`, 'v', Date.now() + 10);
      }
      vi.advanceTimersByTime(20);

      const engine = new ExpiryEngine(store, { sampleSize: 3 });
      expect(engine.tick()).toBe(3);
      expect(store.size).toBe(7);
    });

    it('does not touch keys without a TTL', () => {
      const store = new DataStore();
      store.set('permanent', 'v');
      vi.advanceTimersByTime(10_000);

      const engine = new ExpiryEngine(store, { sampleSize: 10 });
      expect(engine.tick()).toBe(0);
      expect(store.get('permanent')).toBe('v');
    });

    it('does not remove a key whose TTL has not passed yet', () => {
      const store = new DataStore();
      store.set('foo', 'bar', Date.now() + 10_000);

      const engine = new ExpiryEngine(store, { sampleSize: 10 });
      expect(engine.tick()).toBe(0);
      expect(store.get('foo')).toBe('bar');
    });
  });

  describe('start / stop', () => {
    it('runs a sweep on the configured interval once a key has actually expired', () => {
      const store = new DataStore();
      store.set('a', '1', Date.now() + 50);

      const engine = new ExpiryEngine(store, { intervalMs: 20, sampleSize: 10 });
      engine.start();

      vi.advanceTimersByTime(19);
      expect(store.size).toBe(1); // no tick has fired yet

      // Ticks fire at 20, 40, 60... The key expires at 50, so it survives
      // the 20ms and 40ms ticks and is only removed by the one at 60ms.
      vi.advanceTimersByTime(45); // total 64ms — past the 60ms tick
      expect(store.size).toBe(0);

      engine.stop();
    });

    it('stop() prevents any further sweeps', () => {
      const store = new DataStore();
      store.set('a', '1', Date.now() + 10);

      const engine = new ExpiryEngine(store, { intervalMs: 10, sampleSize: 10 });
      engine.start();
      engine.stop();

      vi.advanceTimersByTime(1000);
      expect(store.size).toBe(1); // nothing ever ran the sweep after stop()
    });

    it('stop() is safe to call when never started', () => {
      const store = new DataStore();
      const engine = new ExpiryEngine(store);
      expect(() => engine.stop()).not.toThrow();
    });

    it('start() is idempotent — a second call does not create a second interval', () => {
      const store = new DataStore();
      const sweepSpy = vi.spyOn(store, 'sweepExpired');

      const engine = new ExpiryEngine(store, { intervalMs: 10, sampleSize: 5 });
      engine.start();
      engine.start();

      vi.advanceTimersByTime(10);
      expect(sweepSpy).toHaveBeenCalledTimes(1);

      engine.stop();
    });

    it('uses the default interval and sample size when none are given', () => {
      const store = new DataStore();
      store.set('a', '1', Date.now() + 50);

      const engine = new ExpiryEngine(store);
      engine.start();

      vi.advanceTimersByTime(150); // comfortably past the 100ms default interval + TTL
      expect(store.size).toBe(0);

      engine.stop();
    });
  });
});
