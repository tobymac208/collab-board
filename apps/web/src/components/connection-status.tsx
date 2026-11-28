"use client";

import { useConnectionStatus } from "@/lib/sync";

export function ConnectionStatus() {
  const state = useConnectionStatus();

  if (state.status === "outdated") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="inline-flex items-center gap-2 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
      >
        <span className="size-2 rounded-full bg-amber-500" aria-hidden />A new version is available.
        <button type="button" className="font-medium underline" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }

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
