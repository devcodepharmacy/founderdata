const enc = new TextEncoder();

/**
 * PBKDF2-SHA256 rounds for a new password. 30,000 takes about 5 ms of CPU, which fits the Free plan's 10 ms a request.
 * 100,000 is the most Workers' WebCrypto accepts and takes about 20 ms, so it needs Workers Paid: set PASSWORD_ITERATIONS.
 * The hash string carries its own count, so old passwords still verify, and a sign-in rewrites a hash whose count
 * differs from the target. It runs at sign-in and when an invite is accepted, never on a normal request.
 */
export const PBKDF2_ITERATIONS = 30_000;
export const MIN_ITERATIONS = 10_000;
export const MAX_ITERATIONS = 100_000;

/** The target count: PASSWORD_ITERATIONS clamped to 10,000 to 100,000, or the default when unset or not a number. */
export function passwordIterations(env: { PASSWORD_ITERATIONS?: string }): number {
  const n = Number(env.PASSWORD_ITERATIONS?.trim());
  if (!env.PASSWORD_ITERATIONS?.trim() || !Number.isFinite(n)) return PBKDF2_ITERATIONS;
  return Math.min(MAX_ITERATIONS, Math.max(MIN_ITERATIONS, Math.round(n)));
}

/** The count stored in a hash string, or 0 when it is malformed. */
export function storedIterations(stored: string): number {
  const n = Number(stored.split('$')[1]);
  return Number.isInteger(n) ? n : 0;
}
const SCHEME = 'pbkdf2-sha256';

const toB64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

/** `pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>`, with a fresh 16-byte salt. */
export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${SCHEME}$${iterations}$${toB64(salt)}$${toB64(await derive(password, salt, iterations))}`;
}

/** True when the password matches a hashPassword string. A malformed string, or a count above the platform limit, is false. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, rounds, salt, hash] = stored.split('$');
  const iterations = Number(rounds);
  if (scheme !== SCHEME || !salt || !hash || !Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) return false;
  try {
    const got = toB64(await derive(password, fromB64(salt), iterations));
    let diff = got.length ^ hash.length;
    for (let i = 0; i < got.length && i < hash.length; i++) diff |= got.charCodeAt(i) ^ hash.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}

const DUMMY_SALT = new Uint8Array(16);
/** Spend the time of one check at the target count on a name that does not exist. One derivation, nothing stored. */
export async function verifyDummy(password: string, iterations = PBKDF2_ITERATIONS): Promise<void> {
  await derive(password, DUMMY_SALT, iterations);
}
