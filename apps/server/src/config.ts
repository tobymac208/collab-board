export interface ServerConfig {
  port: number;
  /**
   * Origins allowed to open WebSocket connections and call the HTTP API with
   * credentials. Empty means allow any (dev/test only; refused in production).
   */
  allowedOrigins: string[];
  /** Mark the session cookie `Secure` (HTTPS only). */
  cookieSecure: boolean;
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
  const production = env.NODE_ENV === "production";
  if (production && allowedOrigins.length === 0) {
    throw new Error("ALLOWED_ORIGINS must be set in production");
  }
  const cookieSecure = env.COOKIE_SECURE ? env.COOKIE_SECURE === "true" : production;
  return { port, allowedOrigins, cookieSecure };
}

export function loadDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
  return url;
}
