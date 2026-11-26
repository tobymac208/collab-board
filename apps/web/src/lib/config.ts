/** WebSocket endpoint. Inlined at build time; defaults to the local dev server. */
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000/ws";
