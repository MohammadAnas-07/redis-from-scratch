// Server configuration: port, persistence paths/intervals, and related settings.

/** Default TCP listening port, matching real Redis's default. */
export const DEFAULT_PORT = 6379;

/** Default AOF file path, relative to the process's working directory. */
export const DEFAULT_AOF_PATH = './data/appendonly.aof';

/** Default snapshot file path, relative to the process's working directory. */
export const DEFAULT_SNAPSHOT_PATH = './data/dump.snapshot';

/** Default number of writes between automatic background saves. */
export const DEFAULT_SNAPSHOT_WRITE_THRESHOLD = 100;

/** Default interval (ms) between automatic background saves. */
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 60_000;

export interface ServerConfig {
  port: number;
  aofPath: string;
  snapshotPath: string;
  snapshotWriteThreshold: number;
  snapshotIntervalMs: number;
}

/**
 * Loads server configuration from environment variables, falling back to
 * defaults where unset: the listening port via `PORT`, the AOF file path
 * via `AOF_PATH`, the snapshot file path via `SNAPSHOT_PATH`, and the
 * background-save triggers via `SNAPSHOT_WRITE_THRESHOLD` (writes) and
 * `SNAPSHOT_INTERVAL_MS` (time).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: loadPort(env),
    aofPath: loadAofPath(env),
    snapshotPath: loadSnapshotPath(env),
    snapshotWriteThreshold: loadPositiveInt(
      env,
      'SNAPSHOT_WRITE_THRESHOLD',
      DEFAULT_SNAPSHOT_WRITE_THRESHOLD,
    ),
    snapshotIntervalMs: loadPositiveInt(env, 'SNAPSHOT_INTERVAL_MS', DEFAULT_SNAPSHOT_INTERVAL_MS),
  };
}

function loadPort(env: NodeJS.ProcessEnv): number {
  const raw = env.PORT;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_PORT;
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT env var: "${raw}". Must be an integer between 1 and 65535.`);
  }

  return port;
}

function loadAofPath(env: NodeJS.ProcessEnv): string {
  const raw = env.AOF_PATH;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_AOF_PATH;
  }
  return raw;
}

function loadSnapshotPath(env: NodeJS.ProcessEnv): string {
  const raw = env.SNAPSHOT_PATH;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_SNAPSHOT_PATH;
  }
  return raw;
}

function loadPositiveInt(env: NodeJS.ProcessEnv, varName: string, defaultValue: number): number {
  const raw = env[varName];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${varName} env var: "${raw}". Must be a positive integer.`);
  }

  return value;
}
