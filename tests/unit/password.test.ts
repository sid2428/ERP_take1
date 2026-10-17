import { describe, expect, it } from 'vitest';
import { checkNewPassword, hashPassword, initialPassword, verifyPassword } from '../../src/auth/password.js';

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('Correct horse 9');
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(await verifyPassword('Correct horse 9', hash)).toBe(true);
    expect(await verifyPassword('correct horse 9', hash)).toBe(false);
  });

  it('salts every hash differently', async () => {
    expect(await hashPassword('same-password-1')).not.toBe(await hashPassword('same-password-1'));
  });

  it('treats malformed stored hashes as a failed match', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$1$2$3$abc')).toBe(false);
  });
});

describe('password rules', () => {
  it('builds the initial password from a date as DDMMYYYY', () => {
    expect(initialPassword('2005-04-30')).toBe('30042005');
  });

  it.each([
    ['short1', 'at least 8'],
    ['onlyletters', 'letter and one number'],
    ['12345678', 'letter and one number'],
    ['STU202600004', 'not your login ID'],
  ])('rejects %s', (pw, message) => {
    expect(checkNewPassword(pw, ['STU202600004'])).toMatch(message);
  });

  it('accepts a reasonable password', () => {
    expect(checkNewPassword('library2026', ['STU202600004', '30042005'])).toBeNull();
  });
});
