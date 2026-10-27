import type { NextFunction, Request, Response } from 'express';
import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import { config } from '../config.js';
import { pool } from '../db.js';

const PgStore = connectPgSimple(session);

export const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;   // one working day

/** Sessions live in erp.user_session, so they survive serverless cold starts. */
export const sessionMiddleware = session({
  store: new PgStore({
    pool,
    schemaName: 'erp',
    tableName: 'user_session',
    // serverless instances are short-lived; expired rows are pruned at login instead
    pruneSessionInterval: config.isServerless ? false : 15 * 60,
  }),
  name: 'erp.sid',
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_MS,
  },
});

/**
 * Save a signed-in session (or one carrying a flash message) before redirecting. express-session
 * otherwise sends the redirect's headers while its store write is still running, so the browser's
 * next request can arrive first and miss the new login or flash, e.g. right after sign-in or after
 * submitting a form. Anonymous redirects are left alone so they do not create session rows.
 */
export function saveSessionBeforeRedirect(req: Request, res: Response, next: NextFunction): void {
  const redirect = res.redirect.bind(res) as (...args: unknown[]) => void;
  res.redirect = ((...args: unknown[]) => {
    const s = req.session as (typeof req.session | undefined);
    if (!s || (s.userId === undefined && s.flash === undefined)) {
      redirect(...args);
      return;
    }
    s.save((err) => {
      if (err) console.error('session save before redirect failed', err);
      redirect(...args);
    });
  }) as Response['redirect'];
  next();
}
