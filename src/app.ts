/**
 * Express application (no listen() here: src/server.ts runs it locally, api/index.ts on Vercel).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { queryOne } from './db.js';
import { fmt } from './lib/format.js';
import { NAV } from './lib/nav.js';
import { currentUser, homeFor, requireLogin, requireRole } from './middleware/auth.js';
import { csrf } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { sessionMiddleware } from './middleware/session.js';
import { adminRouter } from './routes/admin/index.js';
import { authRouter } from './routes/auth-routes.js';
import { facultyRouter } from './routes/faculty-routes.js';
import { studentRouter } from './routes/student-routes.js';
import { razorpayWebhookRouter } from './routes/finance-routes.js';

/** Project root (holds views/ and public/), whether running from src/ (tsx) or dist/src/ (compiled). */
function findRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 4; i++) {
    if (existsSync(path.join(dir, 'views'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}
const ROOT = findRoot(import.meta.dirname);

export function createApp(): express.Express {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.set('trust proxy', 1);                  // behind Vercel's proxy: real client IP + secure cookies
  app.disable('x-powered-by');

  app.locals.fmt = fmt;
  app.locals.NAV = NAV;
  app.locals.appName = 'PICT ERP';

    app.use(helmet({
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },   // lets the payment window open
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        styleSrcAttr: ["'unsafe-inline'"],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        scriptSrc: ["'self'", 'https://*.razorpay.com'],
        frameSrc: ["'self'", 'https://*.razorpay.com'],
        connectSrc: ["'self'", 'https://*.razorpay.com'],
        imgSrc: ["'self'", 'data:', 'https://*.razorpay.com'],
        formAction: ["'self'", 'https://*.razorpay.com'],
      },
    },
  }));
  app.use('/static', express.static(path.join(ROOT, 'public'), { maxAge: '7d' }));
  app.get('/healthz', (_req, res) => { res.json({ ok: true }); });

    app.use(razorpayWebhookRouter);   // Razorpay's server calls this; it has no session or CSRF token

  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(sessionMiddleware);
  app.use(csrf);
  app.use(currentUser);

  // current term, shown in the top bar of every page
  app.use(async (_req, res, next) => {
    res.locals.currentSession = await queryOne<{ session_id: string; session_name: string; start_date: string; end_date: string }>(
      'SELECT session_id, session_name, start_date, end_date FROM academic_session WHERE is_current');
    res.locals.nav = null;
    next();
  });

  app.use(authRouter);
  app.get('/', requireLogin, (req, res) => { res.redirect(homeFor(req.user!.role)); });
  app.use('/student', requireLogin, requireRole('student'), studentRouter);
  app.use('/faculty', requireLogin, requireRole('faculty'), facultyRouter);
  app.use('/admin', requireLogin, requireRole('admin'), adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
