"use client";

import { WS_URL } from "@/lib/config";
import { useConnection } from "@/lib/use-connection";

export function ConnectionStatus() {
  const state = useConnection(WS_URL);

  const { dot, label } =
    state.status === "open"
      ? {
          dot: "bg-emerald-500",
          label: `Connected${state.rttMs === null ? "" : ` · ${state.rttMs} ms round trip`}`,
        }
      : state.status === "connecting"
        ? { dot: "bg-amber-400 animate-pulse", label: "Connecting…" }
        : {
            dot: "bg-red-500",
            label: `Disconnected · retrying in ${(state.retryInMs / 1000).toFixed(1)}s`,
          };

  return (
    <div
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-2 rounded-full border border-zinc-200 px-3 py-1 text-sm text-zinc-700 dark:border-zinc-800 dark:text-zinc-300"
    >
      <span className={`size-2 rounded-full ${dot}`} aria-hidden />
      {label}
    </div>
  );
}
