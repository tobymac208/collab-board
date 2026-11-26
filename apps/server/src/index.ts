import { loadConfig } from "./config.ts";
import { createAppServer, WS_PATH } from "./server.ts";

const config = loadConfig();
const { http, wss } = createAppServer(config);

wss.on("connection", (socket, req) => {
  console.log(
    `client connected from ${req.headers.origin ?? "unknown origin"} (${wss.clients.size} open)`,
  );
  socket.on("close", () => console.log(`client disconnected (${wss.clients.size} open)`));
});

http.listen(config.port, () => {
  console.log(`server listening on http://localhost:${config.port} (ws path ${WS_PATH})`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  for (const client of wss.clients) client.close(1001, "server shutting down");
  wss.close();
  http.close(() => process.exit(0));
  // Don't hang forever on stuck connections.
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
