import type { Request, Response } from 'express';
import type { z } from 'zod';
import { friendlyDbError } from '../../db.js';
import { notFound } from '../../lib/http-error.js';
import { flash } from '../../middleware/auth.js';

export function idParam(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
}

/** Empty form fields become NULL. */
export const nullIfEmpty = (s: string | undefined): string | null => (s === undefined || s.trim() === '' ? null : s.trim());

/**
 * Validate a form, run the change, flash the outcome and redirect. Database rule violations
 * (CHECKs, triggers, unique keys) are shown to the admin as readable messages.
 */
export async function handleForm<S extends z.ZodType>(
  req: Request, res: Response, schema: S, redirectTo: string,
  run: (data: z.infer<S>) => Promise<string | { message: string; redirect: string }>,
): Promise<void> {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    flash(req, 'error', parsed.error.issues.map((i) => i.message).join(' · '));
    res.redirect(redirectTo);
    return;
  }
  let target = redirectTo;
  try {
    const outcome = await run(parsed.data);
    if (typeof outcome === 'string') {
      flash(req, 'success', outcome);
    } else {
      flash(req, 'success', outcome.message);
      target = outcome.redirect;
    }
  } catch (err) {
    const message = friendlyDbError(err);
    if (!message) throw err;
    flash(req, 'error', message);
  }
  res.redirect(target);
}
