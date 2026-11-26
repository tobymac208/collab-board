import { z } from "zod";
import { LIMITS, User, fields } from "./model.ts";

/** HTTP auth API (`/auth/*` on the server). Sessions live in an httpOnly cookie. */

export const SignupRequest = z.object({
  email: fields.email,
  password: z.string().min(LIMITS.passwordMin).max(LIMITS.passwordMax),
  displayName: fields.displayName,
});
export type SignupRequest = z.infer<typeof SignupRequest>;

export const LoginRequest = z.object({
  email: z.string().max(LIMITS.email),
  password: z.string().max(LIMITS.passwordMax),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const AuthResponse = z.object({ user: User });
export type AuthResponse = z.infer<typeof AuthResponse>;

export const ApiErrorCode = z.enum([
  "bad_request",
  "invalid_credentials",
  "email_taken",
  "unauthenticated",
  "forbidden",
  "not_found",
  "internal",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export const ApiError = z.object({ error: ApiErrorCode, message: z.string() });
export type ApiError = z.infer<typeof ApiError>;
