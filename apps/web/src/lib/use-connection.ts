"use client";

import { useEffect, useState } from "react";
import { parseServerMessage, type ClientMessage } from "@collab/shared";

export type ConnectionState =
  | { status: "connecting"; attempt: number }
  | { status: "open"; connectionId: string; rttMs: number | null }
  | { status: "closed"; retryInMs: number };

const PING_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 10_000;

/** Exponential backoff with full jitter, so many clients don't reconnect in lockstep. */
export function backoffDelay(attempt: number): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
  return Math.round(Math.random() * ceiling);
}

/**
 * Keeps a WebSocket connection to the server open, reconnecting on failure,
 * and measures round-trip latency with periodic pings.
 */
export function useConnection(url: string): ConnectionState {
  const [state, setState] = useState<ConnectionState>({ status: "connecting", attempt: 0 });

  useEffect(() => {
    let socket: WebSocket | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let disposed = false;

    const send = (msg: ClientMessage) => socket?.send(JSON.stringify(msg));

    const connect = () => {
      setState({ status: "connecting", attempt });
      socket = new WebSocket(url);

      socket.onmessage = (event) => {
        const parsed = parseServerMessage(String(event.data));
        if (!parsed.ok) {
          console.warn("ignoring malformed server message:", parsed.error);
          return;
        }
        const msg = parsed.value;
        switch (msg.type) {
          case "welcome":
            attempt = 0;
            setState({ status: "open", connectionId: msg.connectionId, rttMs: null });
            send({ type: "ping", sentAt: Date.now() });
            pingTimer = setInterval(
              () => send({ type: "ping", sentAt: Date.now() }),
              PING_INTERVAL_MS,
            );
            break;
          case "pong":
            setState((s) => (s.status === "open" ? { ...s, rttMs: Date.now() - msg.sentAt } : s));
            break;
          case "error":
            console.warn(`server error (${msg.code}): ${msg.message}`);
            break;
        }
      };

      socket.onclose = () => {
        clearInterval(pingTimer);
        if (disposed) return;
        const retryInMs = backoffDelay(attempt++);
        setState({ status: "closed", retryInMs });
        retryTimer = setTimeout(connect, retryInMs);
      };
    };

    connect();

    return () => {
      disposed = true;
      clearInterval(pingTimer);
      clearTimeout(retryTimer);
      socket?.close();
    };
  }, [url]);

  return state;
}
