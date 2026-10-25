import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../lib/http-error.js';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function tokensMatch(expected: string | undefined, given: unknown): boolean {
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Synchronizer-token CSRF protection: every form carries the session's token in `_csrf`. */
export function csrf(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.csrfToken) req.session.csrfToken = randomBytes(32).toString('base64url');
  res.locals.csrfToken = req.session.csrfToken;
  const legacyFacultyApi = req.path.startsWith('/api/faculty/') || req.path.startsWith('/faculty/api/faculty/');
  if (legacyFacultyApi && !req.user) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  if (UNSAFE.has(req.method)) {
    const given = (req.body as Record<string, unknown> | undefined)?._csrf ?? req.get('x-csrf-token');
    if (!tokensMatch(req.session.csrfToken, given)) {
      if (req.path.startsWith('/api/') || req.path.startsWith('/faculty/api/')) {
        res.status(403).json({ error: 'A valid CSRF token is required.' });
        return;
      }
      next(new HttpError(403, 'Your form has expired. Please go back, reload the page and try again.'));
      return;
    }
  }
  next();
}
