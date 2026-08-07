import { describe, expect, it } from 'vitest';
import { DEFAULT_AOF_PATH, DEFAULT_PORT, loadConfig } from '../../src/config/config.js';

describe('loadConfig', () => {
  it('defaults to port 6379 and the default AOF path when nothing is set', () => {
    expect(loadConfig({})).toEqual({ port: DEFAULT_PORT, aofPath: DEFAULT_AOF_PATH });
  });

  it('ignores an empty PORT value and falls back to the default', () => {
    expect(loadConfig({ PORT: '' })).toEqual({ port: DEFAULT_PORT, aofPath: DEFAULT_AOF_PATH });
  });

  it('uses the PORT env var when set', () => {
    expect(loadConfig({ PORT: '7000' })).toEqual({ port: 7000, aofPath: DEFAULT_AOF_PATH });
  });

  it('throws on a non-numeric PORT', () => {
    expect(() => loadConfig({ PORT: 'not-a-number' })).toThrow(/Invalid PORT/);
  });

  it('throws on an out-of-range PORT', () => {
    expect(() => loadConfig({ PORT: '0' })).toThrow(/Invalid PORT/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/Invalid PORT/);
  });

  it('throws on a non-integer PORT', () => {
    expect(() => loadConfig({ PORT: '6379.5' })).toThrow(/Invalid PORT/);
  });

  it('uses the AOF_PATH env var when set', () => {
    expect(loadConfig({ AOF_PATH: '/tmp/custom.aof' })).toEqual({
      port: DEFAULT_PORT,
      aofPath: '/tmp/custom.aof',
    });
  });

  it('ignores an empty AOF_PATH value and falls back to the default', () => {
    expect(loadConfig({ AOF_PATH: '' })).toEqual({ port: DEFAULT_PORT, aofPath: DEFAULT_AOF_PATH });
  });

  it('reads PORT and AOF_PATH together', () => {
    expect(loadConfig({ PORT: '7000', AOF_PATH: '/tmp/custom.aof' })).toEqual({
      port: 7000,
      aofPath: '/tmp/custom.aof',
    });
  });
});
