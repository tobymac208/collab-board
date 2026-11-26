export interface ServerConfig {
  port: number;
  /** Origins allowed to open WebSocket connections. Empty means allow any (dev/test only). */
  allowedOrigins: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? 4000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return { port, allowedOrigins };
}
