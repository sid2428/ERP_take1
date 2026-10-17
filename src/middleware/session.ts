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
