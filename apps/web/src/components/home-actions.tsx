"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth";

const linkClass = "rounded-md px-4 py-2 text-sm font-medium transition-colors";
const primary = `${linkClass} bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300`;
const secondary = `${linkClass} border border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900`;

export function HomeActions() {
  const { state } = useAuth();

  if (state.status === "loading") return <div className="h-9" aria-hidden />;
  if (state.status === "error") {
    return <p className="text-sm text-red-600 dark:text-red-400">{state.message}</p>;
  }
  if (state.status === "authenticated") {
    return (
      <Link href="/boards" className={primary}>
        Go to your boards →
      </Link>
    );
  }
  return (
    <div className="flex gap-3">
      <Link href="/signup" className={primary}>
        Sign up
      </Link>
      <Link href="/login" className={secondary}>
        Log in
      </Link>
    </div>
  );
}
