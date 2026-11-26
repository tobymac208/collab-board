import { loadConfig, loadDatabaseUrl } from "./config.ts";
import { connect } from "./db/connect.ts";
import { migrateToLatest } from "./db/migrate.ts";
import { deleteExpiredSessions } from "./auth/sessions.ts";
import { createAppServer, WS_PATH } from "./server.ts";

const config = loadConfig();
const db = connect(loadDatabaseUrl());
await migrateToLatest(db);

const { http, wss } = createAppServer(config, db);

wss.on("connection", (socket, req) => {
  console.log(
    `client connected from ${req.headers.origin ?? "unknown origin"} (${wss.clients.size} open)`,
  );
  socket.on("close", () => console.log(`client disconnected (${wss.clients.size} open)`));
});

const sweep = setInterval(
  () =>
    deleteExpiredSessions(db).catch((err: unknown) => console.error("session sweep failed", err)),
  60 * 60 * 1000,
);
sweep.unref();

http.listen(config.port, () => {
  console.log(`server listening on http://localhost:${config.port} (ws path ${WS_PATH})`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  for (const client of wss.clients) client.close(1001, "server shutting down");
  wss.close();
  http.close(() => {
    db.destroy().finally(() => process.exit(0));
  });
  // Don't hang forever on stuck connections.
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
