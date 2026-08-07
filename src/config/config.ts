// Server configuration: port, persistence paths/intervals, and related settings.

/** Default TCP listening port, matching real Redis's default. */
export const DEFAULT_PORT = 6379;

/** Default AOF file path, relative to the process's working directory. */
export const DEFAULT_AOF_PATH = './data/appendonly.aof';

export interface ServerConfig {
  port: number;
  aofPath: string;
}

/**
 * Loads server configuration from environment variables, falling back to
 * defaults where unset: the listening port via `PORT`, and the AOF file
 * path via `AOF_PATH`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: loadPort(env),
    aofPath: loadAofPath(env),
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
