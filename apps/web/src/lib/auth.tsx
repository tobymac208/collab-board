"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { LoginRequest, SignupRequest, User } from "@collab/shared";
import * as api from "./api";

export type AuthState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: User }
  | { status: "error"; message: string };

interface AuthContextValue {
  state: AuthState;
  login: (input: LoginRequest) => Promise<void>;
  signup: (input: SignupRequest) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-checks the session, e.g. after the server says it ended. */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  const refresh = useCallback(async () => {
    try {
      const user = await api.me();
      setState(user ? { status: "authenticated", user } : { status: "anonymous" });
    } catch (err) {
      setState({ status: "error", message: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    // Initial session check; setState happens after the await, not synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      refresh,
      login: async (input) => {
        setState({ status: "authenticated", user: await api.login(input) });
      },
      signup: async (input) => {
        setState({ status: "authenticated", user: await api.signup(input) });
      },
      logout: async () => {
        await api.logout();
        setState({ status: "anonymous" });
      },
    }),
    [state, refresh],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
