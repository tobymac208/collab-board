"use client";

import { useConnectionStatus } from "@/lib/sync";

export function ConnectionStatus() {
  const state = useConnectionStatus();

  const { dot, label } =
    state.status === "open"
      ? {
          dot: "bg-emerald-500",
          label: `Connected${state.rttMs === null ? "" : ` · ${state.rttMs} ms`}`,
        }
      : state.status === "connecting"
        ? { dot: "bg-amber-400 animate-pulse", label: "Connecting…" }
        : state.status === "closed"
          ? {
              dot: "bg-red-500",
              label: `Offline · retrying in ${(state.retryInMs / 1000).toFixed(1)}s`,
            }
          : { dot: "bg-zinc-400", label: "Signed out" };

  return (
    <div
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-2 rounded-full border border-zinc-200 px-2.5 py-0.5 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400"
    >
      <span className={`size-2 rounded-full ${dot}`} aria-hidden />
      {label}
    </div>
  );
}
