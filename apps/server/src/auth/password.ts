import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing with scrypt (built into Node, no native addon).
 *
 * Stored format: `scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>`. Parameters are
 * stored with each hash so they can be raised later without invalidating
 * existing passwords.
 */

const DEFAULT_PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 32;

function scrypt(password: string, salt: Buffer, params: typeof DEFAULT_PARAMS): Promise<Buffer> {
  // scrypt needs 128 * N * r bytes; give it headroom over Node's 32 MiB default.
  const options: ScryptOptions = { ...params, maxmem: 256 * params.N * params.r };
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize("NFKC"), salt, KEY_LENGTH, options, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string, params = DEFAULT_PARAMS): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, params);
  return [
    "scrypt",
    params.N,
    params.r,
    params.p,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * A real hash of a random password. Login verifies against this when the email
 * is unknown, so response time doesn't reveal which emails have accounts.
 */
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  return dummyHash;
}
