/**
 * Password hashing with Node's built-in scrypt (memory-hard; no native add-on needed on Vercel).
 * Stored format: scrypt$N$r$p$<salt base64url>$<hash base64url>
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const MAX_MEMORY = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, keyLength, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEMORY });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltText, hashText] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashText, 'base64url');
  try {
    const actual = await derive(password, Buffer.from(saltText, 'base64url'), expected.length,
      { N: Number(n), r: Number(r), p: Number(p), maxmem: MAX_MEMORY });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Initial password issued with a generated account: the person's date (DDMMYYYY). */
export function initialPassword(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${d}${m}${y}`;
}

/** Returns an error message, or null if the new password is acceptable. */
export function checkNewPassword(password: string, forbidden: string[] = []): string | null {
  if (password.length < 8) return 'Use at least 8 characters.';
  if (password.length > 128) return 'Use at most 128 characters.';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Use at least one letter and one number.';
  const lower = password.toLowerCase();
  if (forbidden.some((f) => f && lower === f.toLowerCase())) return 'Choose a password that is not your login ID or initial password.';
  return null;
}
