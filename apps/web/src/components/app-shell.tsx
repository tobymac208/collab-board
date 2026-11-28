"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { countUnsent } from "@/lib/offline-store";
import { SyncProvider } from "@/lib/sync";
import { ConnectionStatus } from "./connection-status";
import { Button, useConfirm } from "./ui";

/** Layout for the logged-in area: requires a session and owns the WebSocket. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { state, logout, refresh } = useAuth();
  const router = useRouter();

  const [confirm, confirmDialog] = useConfirm();

  /** Logging out discards unsent offline changes, so say so first. */
  async function confirmLogout(userId: string) {
    const unsent = countUnsent(userId);
    if (unsent > 0) {
      const ok = await confirm({
        title: "Log out with unsent changes?",
        message: `You have ${unsent} change${unsent === 1 ? "" : "s"} that haven't reached the server yet. Logging out will discard them.`,
        confirmLabel: "Log out anyway",
        danger: true,
      });
      if (!ok) return;
    }
    await logout();
  }

  useEffect(() => {
    if (state.status === "anonymous") router.replace("/login");
  }, [state.status, router]);

  if (state.status === "error") {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
        <p className="text-sm text-red-600 dark:text-red-400">{state.message}</p>
        <Button variant="secondary" onClick={() => void refresh()}>
          Try again
        </Button>
      </main>
    );
  }
  // Render the page even while the session check is pending: the page shows
  // its own loading state, which becomes the prerendered instant shell.
  // Keyed by user so switching accounts never leaks one user's state.
  const user = state.status === "authenticated" ? state.user : null;
  return (
    <SyncProvider
      key={user?.id ?? "pending"}
      enabled={user !== null}
      onSessionEnded={() => void refresh()}
    >
      <header className="flex items-center gap-4 border-b border-zinc-200 px-6 py-3 dark:border-zinc-800">
        <Link href="/boards" className="font-semibold tracking-tight">
          Collab Board
        </Link>
        <ConnectionStatus />
        {user && (
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">{user.displayName}</span>
            <Button variant="ghost" onClick={() => void confirmLogout(user.id)}>
              Log out
            </Button>
          </div>
        )}
      </header>
      {children}
      {confirmDialog}
    </SyncProvider>
  );
}
