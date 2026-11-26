// Inlined at build time; defaults point at the local dev server.

/** WebSocket endpoint. */
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000/ws";

/** HTTP API (auth). Must be same-site with the web app so the session cookie is sent. */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
