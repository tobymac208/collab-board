import type { User } from "@collab/shared";
import type { DB } from "../db/schema.ts";
import { getDummyHash, hashPassword, verifyPassword } from "./password.ts";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export class EmailTakenError extends Error {
  constructor() {
    super("an account with this email already exists");
  }
}

export async function createUser(
  db: DB,
  input: { email: string; password: string; displayName: string },
): Promise<User> {
  const email = normalizeEmail(input.email);
  const passwordHash = await hashPassword(input.password);
  const row = await db
    .insertInto("users")
    .values({ email, display_name: input.displayName, password_hash: passwordHash })
    .onConflict((oc) => oc.column("email").doNothing())
    .returning(["id", "email", "display_name"])
    .executeTakeFirst();
  if (!row) throw new EmailTakenError();
  return { id: row.id, email: row.email, displayName: row.display_name };
}

/** Returns the user if the credentials match, otherwise null. */
export async function authenticate(db: DB, email: string, password: string): Promise<User | null> {
  const row = await db
    .selectFrom("users")
    .select(["id", "email", "display_name", "password_hash"])
    .where("email", "=", normalizeEmail(email))
    .executeTakeFirst();
  // Always run scrypt so timing doesn't reveal whether the email exists.
  const ok = await verifyPassword(password, row?.password_hash ?? (await getDummyHash()));
  if (!row || !ok) return null;
  return { id: row.id, email: row.email, displayName: row.display_name };
}
