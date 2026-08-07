import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AOF_PATH,
  DEFAULT_PORT,
  DEFAULT_SNAPSHOT_INTERVAL_MS,
  DEFAULT_SNAPSHOT_PATH,
  DEFAULT_SNAPSHOT_WRITE_THRESHOLD,
  loadConfig,
} from '../../src/config/config.js';

/** The full default config, as a base for tests that only vary one field. */
const DEFAULTS = {
  port: DEFAULT_PORT,
  aofPath: DEFAULT_AOF_PATH,
  snapshotPath: DEFAULT_SNAPSHOT_PATH,
  snapshotWriteThreshold: DEFAULT_SNAPSHOT_WRITE_THRESHOLD,
  snapshotIntervalMs: DEFAULT_SNAPSHOT_INTERVAL_MS,
};

describe('loadConfig', () => {
  it('defaults everything when nothing is set', () => {
    expect(loadConfig({})).toEqual(DEFAULTS);
  });

  describe('PORT', () => {
    it('ignores an empty value and falls back to the default', () => {
      expect(loadConfig({ PORT: '' })).toEqual(DEFAULTS);
    });

    it('uses the env var when set', () => {
      expect(loadConfig({ PORT: '7000' })).toEqual({ ...DEFAULTS, port: 7000 });
    });

    it('throws on a non-numeric value', () => {
      expect(() => loadConfig({ PORT: 'not-a-number' })).toThrow(/Invalid PORT/);
    });

    it('throws on an out-of-range value', () => {
      expect(() => loadConfig({ PORT: '0' })).toThrow(/Invalid PORT/);
      expect(() => loadConfig({ PORT: '70000' })).toThrow(/Invalid PORT/);
    });

    it('throws on a non-integer value', () => {
      expect(() => loadConfig({ PORT: '6379.5' })).toThrow(/Invalid PORT/);
    });
  });

  describe('AOF_PATH', () => {
    it('uses the env var when set', () => {
      expect(loadConfig({ AOF_PATH: '/tmp/custom.aof' })).toEqual({
        ...DEFAULTS,
        aofPath: '/tmp/custom.aof',
      });
    });

    it('ignores an empty value and falls back to the default', () => {
      expect(loadConfig({ AOF_PATH: '' })).toEqual(DEFAULTS);
    });
  });

  describe('SNAPSHOT_PATH', () => {
    it('uses the env var when set', () => {
      expect(loadConfig({ SNAPSHOT_PATH: '/tmp/custom.snapshot' })).toEqual({
        ...DEFAULTS,
        snapshotPath: '/tmp/custom.snapshot',
      });
    });

    it('ignores an empty value and falls back to the default', () => {
      expect(loadConfig({ SNAPSHOT_PATH: '' })).toEqual(DEFAULTS);
    });
  });

  describe('SNAPSHOT_WRITE_THRESHOLD', () => {
    it('uses the env var when set', () => {
      expect(loadConfig({ SNAPSHOT_WRITE_THRESHOLD: '50' })).toEqual({
        ...DEFAULTS,
        snapshotWriteThreshold: 50,
      });
    });

    it('ignores an empty value and falls back to the default', () => {
      expect(loadConfig({ SNAPSHOT_WRITE_THRESHOLD: '' })).toEqual(DEFAULTS);
    });

    it('throws on a non-numeric value', () => {
      expect(() => loadConfig({ SNAPSHOT_WRITE_THRESHOLD: 'lots' })).toThrow(
        /Invalid SNAPSHOT_WRITE_THRESHOLD/,
      );
    });

    it('throws on zero or a negative value', () => {
      expect(() => loadConfig({ SNAPSHOT_WRITE_THRESHOLD: '0' })).toThrow(
        /Invalid SNAPSHOT_WRITE_THRESHOLD/,
      );
      expect(() => loadConfig({ SNAPSHOT_WRITE_THRESHOLD: '-5' })).toThrow(
        /Invalid SNAPSHOT_WRITE_THRESHOLD/,
      );
    });

    it('throws on a non-integer value', () => {
      expect(() => loadConfig({ SNAPSHOT_WRITE_THRESHOLD: '10.5' })).toThrow(
        /Invalid SNAPSHOT_WRITE_THRESHOLD/,
      );
    });
  });

  describe('SNAPSHOT_INTERVAL_MS', () => {
    it('uses the env var when set', () => {
      expect(loadConfig({ SNAPSHOT_INTERVAL_MS: '5000' })).toEqual({
        ...DEFAULTS,
        snapshotIntervalMs: 5000,
      });
    });

    it('ignores an empty value and falls back to the default', () => {
      expect(loadConfig({ SNAPSHOT_INTERVAL_MS: '' })).toEqual(DEFAULTS);
    });

    it('throws on a non-numeric value', () => {
      expect(() => loadConfig({ SNAPSHOT_INTERVAL_MS: 'soon' })).toThrow(
        /Invalid SNAPSHOT_INTERVAL_MS/,
      );
    });

    it('throws on zero or a negative value', () => {
      expect(() => loadConfig({ SNAPSHOT_INTERVAL_MS: '0' })).toThrow(
        /Invalid SNAPSHOT_INTERVAL_MS/,
      );
    });
  });

  it('reads every env var together', () => {
    expect(
      loadConfig({
        PORT: '7000',
        AOF_PATH: '/tmp/custom.aof',
        SNAPSHOT_PATH: '/tmp/custom.snapshot',
        SNAPSHOT_WRITE_THRESHOLD: '10',
        SNAPSHOT_INTERVAL_MS: '2000',
      }),
    ).toEqual({
      port: 7000,
      aofPath: '/tmp/custom.aof',
      snapshotPath: '/tmp/custom.snapshot',
      snapshotWriteThreshold: 10,
      snapshotIntervalMs: 2000,
    });
  });
});
