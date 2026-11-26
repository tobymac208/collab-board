"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useState,
  useSyncExternalStore,
} from "react";
import type { ClientRequestBody, ServerEvent } from "@collab/shared";
import * as api from "./api";
import { WS_URL } from "./config";
import { SyncClient, type ConnectionStatus } from "./sync-client";

interface SyncContextValue {
  client: SyncClient;
  /** Shows an error message to the user. */
  reportError: (message: string) => void;
}

const SyncContext = createContext<SyncContextValue | null>(null);

/**
 * Owns the app's single WebSocket connection for as long as the user is in
 * the logged-in part of the app.
 *
 * Children always render, even before we know who is logged in, so pages can
 * show their loading state straight away (and Next.js can prerender it as the
 * instant navigation shell). The connection only opens once `enabled`.
 */
export function SyncProvider({
  children,
  enabled,
  onSessionEnded,
}: {
  children: React.ReactNode;
  enabled: boolean;
  onSessionEnded: () => void;
}) {
  const [client] = useState(
    () => new SyncClient(WS_URL, { isSessionValid: async () => (await api.me()) !== null }),
  );
  const [errors, setErrors] = useState<{ id: number; message: string }[]>([]);

  useEffect(() => {
    if (!enabled) return;
    client.start();
    return () => client.stop();
  }, [client, enabled]);

  const status = useSyncExternalStore(client.subscribeStatus, client.getStatus, client.getStatus);
  const sessionEnded = useEffectEvent(onSessionEnded);
  useEffect(() => {
    if (status.status === "ended") sessionEnded();
  }, [status.status]);

  const reportError = useCallback((message: string) => {
    const id = Date.now() + Math.random();
    setErrors((list) => [...list.slice(-2), { id, message }]);
    setTimeout(() => setErrors((list) => list.filter((e) => e.id !== id)), 5_000);
  }, []);

  return (
    <SyncContext value={{ client, reportError }}>
      {children}
      <div
        aria-live="assertive"
        className="pointer-events-none fixed inset-x-0 bottom-4 flex flex-col items-center gap-2"
      >
        {errors.map((e) => (
          <div
            key={e.id}
            role="alert"
            className="pointer-events-auto rounded-md bg-red-600 px-4 py-2 text-sm text-white shadow-lg"
          >
            {e.message}
          </div>
        ))}
      </div>
    </SyncContext>
  );
}

function useSyncContext(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error("must be used inside <SyncProvider>");
  return ctx;
}

/** Shows a short message to the user (the same toast that reports errors). */
export function useNotify(): (message: string) => void {
  return useSyncContext().reportError;
}

/** The raw client, for callers that handle request errors themselves. */
export function useSyncClient(): SyncClient {
  return useSyncContext().client;
}

export function useConnectionStatus(): ConnectionStatus {
  const { client } = useSyncContext();
  return useSyncExternalStore(client.subscribeStatus, client.getStatus, client.getStatus);
}

/** Calls `listener` for every state event from the server. */
export function useServerEvents(listener: (event: ServerEvent) => void): void {
  const { client } = useSyncContext();
  const onEvent = useEffectEvent(listener);
  useEffect(() => client.onEvent((e) => onEvent(e)), [client]);
}

/**
 * Sends requests and reports failures to the user. Resolves with the
 * request's events, or null if it failed (already reported), so callers
 * rarely need their own error handling.
 */
export function useRequest(): (body: ClientRequestBody) => Promise<ServerEvent[] | null> {
  const { client, reportError } = useSyncContext();
  return useCallback(
    async (body) => {
      try {
        return await client.request(body);
      } catch (err) {
        reportError((err as Error).message);
        return null;
      }
    },
    [client, reportError],
  );
}

/** Runs `effect` each time the connection (re)opens, e.g. to reload state. */
export function useOnConnected(effect: () => void): void {
  const status = useConnectionStatus();
  const onConnected = useEffectEvent(effect);
  const open = status.status === "open";
  useEffect(() => {
    if (open) onConnected();
  }, [open]);
}
