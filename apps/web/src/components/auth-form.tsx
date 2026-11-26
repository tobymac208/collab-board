"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LIMITS } from "@collab/shared";
import { useAuth } from "@/lib/auth";
import { Button, Input } from "./ui";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const { state, login, signup } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (state.status === "authenticated") router.replace("/boards");
  }, [state.status, router]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "signup") {
        await signup({ email, password, displayName: String(form.get("displayName")).trim() });
      } else {
        await login({ email, password });
      }
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  const isSignup = mode === "signup";
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <Link href="/" className="text-sm text-zinc-500 hover:underline">
          ← Collab Board
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {isSignup ? "Create an account" : "Log in"}
        </h1>
      </div>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {isSignup && (
          <label className="flex flex-col gap-1 text-sm font-medium">
            Display name
            <Input
              name="displayName"
              required
              maxLength={LIMITS.displayName}
              autoComplete="nickname"
            />
          </label>
        )}
        <label className="flex flex-col gap-1 text-sm font-medium">
          Email
          <Input name="email" type="email" required maxLength={LIMITS.email} autoComplete="email" />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Password
          <Input
            name="password"
            type="password"
            required
            minLength={isSignup ? LIMITS.passwordMin : undefined}
            maxLength={LIMITS.passwordMax}
            autoComplete={isSignup ? "new-password" : "current-password"}
          />
          {isSignup && (
            <span className="text-xs font-normal text-zinc-500">
              At least {LIMITS.passwordMin} characters.
            </span>
          )}
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <Button type="submit" disabled={submitting}>
          {submitting ? "…" : isSignup ? "Sign up" : "Log in"}
        </Button>
      </form>
      <p className="text-sm text-zinc-500">
        {isSignup ? "Already have an account? " : "New here? "}
        <Link href={isSignup ? "/login" : "/signup"} className="font-medium underline">
          {isSignup ? "Log in" : "Create an account"}
        </Link>
      </p>
    </main>
  );
}
