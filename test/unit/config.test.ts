import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, loadConfig } from '../../src/config/config.js';

describe('loadConfig', () => {
  it('defaults to port 6379 when PORT is not set', () => {
    expect(loadConfig({})).toEqual({ port: DEFAULT_PORT });
  });

  it('ignores an empty PORT value and falls back to the default', () => {
    expect(loadConfig({ PORT: '' })).toEqual({ port: DEFAULT_PORT });
  });

  it('uses the PORT env var when set', () => {
    expect(loadConfig({ PORT: '7000' })).toEqual({ port: 7000 });
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
});
