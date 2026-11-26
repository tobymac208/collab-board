import { createHash, randomBytes } from "node:crypto";
import type { User } from "@collab/shared";
import type { DB } from "../db/schema.ts";

export const SESSION_COOKIE = "collab_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The database stores only a hash, so a leaked sessions table can't be replayed. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface Session {
  id: string;
  user: User;
}

export async function createSession(
  db: DB,
  userId: string,
): Promise<{ token: string; id: string }> {
  const token = randomBytes(32).toString("base64url");
  const id = hashToken(token);
  await db
    .insertInto("sessions")
    .values({ id, user_id: userId, expires_at: new Date(Date.now() + SESSION_TTL_MS) })
    .execute();
  return { token, id };
}

export async function findSession(db: DB, token: string): Promise<Session | null> {
  const row = await db
    .selectFrom("sessions")
    .innerJoin("users", "users.id", "sessions.user_id")
    .select(["sessions.id as sessionId", "users.id", "users.email", "users.display_name"])
    .where("sessions.id", "=", hashToken(token))
    .where("sessions.expires_at", ">", new Date())
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.sessionId,
    user: { id: row.id, email: row.email, displayName: row.display_name },
  };
}

export async function deleteSession(db: DB, token: string): Promise<string> {
  const id = hashToken(token);
  await db.deleteFrom("sessions").where("id", "=", id).execute();
  return id;
}

export async function deleteExpiredSessions(db: DB): Promise<void> {
  await db.deleteFrom("sessions").where("expires_at", "<=", new Date()).execute();
}

// ---- cookies -------------------------------------------------------------

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined; // malformed percent-encoding
    }
  }
  return undefined;
}

export function sessionCookie(token: string, secure: boolean): string {
  return serializeCookie(token, Math.floor(SESSION_TTL_MS / 1000), secure);
}

export function clearedSessionCookie(secure: boolean): string {
  return serializeCookie("", 0, secure);
}

function serializeCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  // SameSite=Lax: sent on same-site requests (localhost:3000 -> localhost:4000
  // counts, ports don't matter) but not on cross-site subrequests.
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
