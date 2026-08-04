// Server configuration: port, persistence paths/intervals, and related settings.

/** Default TCP listening port, matching real Redis's default. */
export const DEFAULT_PORT = 6379;

export interface ServerConfig {
  port: number;
}

/**
 * Loads server configuration from environment variables, falling back to
 * defaults where unset. Currently only the listening port is configurable,
 * via the `PORT` env var.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const raw = env.PORT;
  if (raw === undefined || raw.trim() === '') {
    return { port: DEFAULT_PORT };
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT env var: "${raw}". Must be an integer between 1 and 65535.`);
  }

  return { port };
}
