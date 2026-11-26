import {
  ApiError,
  AuthResponse,
  type LoginRequest,
  type SignupRequest,
  type User,
} from "@collab/shared";
import { API_URL } from "./config";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      // The session lives in an httpOnly cookie on the API's origin.
      credentials: "include",
      headers: init.body ? { "content-type": "application/json" } : {},
    });
  } catch {
    throw new ApiRequestError(0, "network", "Can't reach the server. Is it running?");
  }
  if (!res.ok) {
    const body = ApiError.safeParse(await res.json().catch(() => null));
    throw body.success
      ? new ApiRequestError(res.status, body.data.error, body.data.message)
      : new ApiRequestError(res.status, "unknown", `request failed (${res.status})`);
  }
  return res;
}

async function userFrom(res: Response): Promise<User> {
  return AuthResponse.parse(await res.json()).user;
}

export async function signup(input: SignupRequest): Promise<User> {
  return userFrom(await call("/auth/signup", { method: "POST", body: JSON.stringify(input) }));
}

export async function login(input: LoginRequest): Promise<User> {
  return userFrom(await call("/auth/login", { method: "POST", body: JSON.stringify(input) }));
}

export async function logout(): Promise<void> {
  await call("/auth/logout", { method: "POST" });
}

/** The logged-in user, or null if there is no valid session. */
export async function me(): Promise<User | null> {
  try {
    return await userFrom(await call("/auth/me"));
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 401) return null;
    throw err;
  }
}
