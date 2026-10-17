import { Router, type Request } from 'express';
import { z } from 'zod';
import { checkNewPassword, hashPassword, initialPassword, verifyPassword } from '../auth/password.js';
import { pool, query, queryOne } from '../db.js';
import { audit } from '../lib/audit.js';
import { flash, homeFor, requireLogin } from '../middleware/auth.js';
import type { Role } from '../types.js';

export const authRouter = Router();

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
// verified when the login id is unknown, so response time does not reveal which ids exist
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const loginSchema = z.object({
  login_id: z.string().trim().min(1).max(20),
  password: z.string().min(1).max(128),
  next: z.string().optional(),
});

function safeNext(next: string | undefined): string | null {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login') ? next : null;
}

function regenerate(req: Request): Promise<void> {
  return new Promise((resolve, reject) => { req.session.regenerate((err) => (err ? reject(err) : resolve())); });
}

authRouter.get('/login', (req, res) => {
  if (req.user && !req.user.mustChangePassword) {
    res.redirect(homeFor(req.user.role));
    return;
  }
  res.render('auth/login', { title: 'Sign in', error: null, loginId: '', next: req.query.next ?? '' });
});

authRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  const loginId = parsed.success ? parsed.data.login_id : String(req.body?.login_id ?? '');
  const next = parsed.success ? parsed.data.next : undefined;
  const fail = (error: string): void => {
    res.status(401).render('auth/login', { title: 'Sign in', error, loginId, next: next ?? '' });
  };
  if (!parsed.success) {
    fail('Enter your login ID and password.');
    return;
  }

  const user = await queryOne<{
    user_id: number; password_hash: string; role: Role; is_active: boolean; failed_logins: number;
    locked_until: Date | null;
  }>(`SELECT user_id, password_hash, role, is_active, failed_logins, locked_until
        FROM app_user WHERE login_id IN ($1::varchar, upper($1::varchar), lower($1::varchar)) LIMIT 1`, [loginId]);

  if (!user || !user.is_active) {
    await verifyPassword(parsed.data.password, DUMMY_HASH);
    await audit(req, { action: 'LOGIN_FAILED', entity: 'app_user', details: { login_id: loginId }, userId: null });
    fail('Incorrect login ID or password.');
    return;
  }
  if (user.locked_until && user.locked_until > new Date()) {
    const minutes = Math.ceil((user.locked_until.getTime() - Date.now()) / 60_000);
    fail(`Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    return;
  }
  if (!(await verifyPassword(parsed.data.password, user.password_hash))) {
    const locked = user.failed_logins + 1 >= MAX_FAILED_LOGINS;
    await pool.query(
      `UPDATE app_user SET failed_logins = CASE WHEN $2 THEN 0 ELSE failed_logins + 1 END,
              locked_until = CASE WHEN $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
        WHERE user_id = $1`, [user.user_id, locked, LOCK_MINUTES]);
    await audit(req, { action: locked ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED', entity: 'app_user', entityId: user.user_id, userId: user.user_id });
    fail(locked ? `Too many failed attempts. Your account is locked for ${LOCK_MINUTES} minutes.` : 'Incorrect login ID or password.');
    return;
  }

  await pool.query('UPDATE app_user SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE user_id = $1', [user.user_id]);
  await regenerate(req);                       // new session id on login (prevents session fixation)
  req.session.userId = user.user_id;
  await audit(req, { action: 'LOGIN', entity: 'app_user', entityId: user.user_id, userId: user.user_id });
  if (Math.random() < 0.05) await pool.query('DELETE FROM user_session WHERE expire < now()');
  res.redirect(safeNext(next) ?? homeFor(user.role));
});

authRouter.post('/logout', async (req, res) => {
  if (req.user) await audit(req, { action: 'LOGOUT', entity: 'app_user', entityId: req.user.userId });
  req.session.destroy(() => {
    res.clearCookie('erp.sid');
    res.redirect('/login');
  });
});

// ---------------------------------------------------------------------------------------------
const passwordSchema = z.object({
  current_password: z.string().min(1).max(128),
  new_password: z.string().max(128),
  confirm_password: z.string().max(128),
});

authRouter.get('/account/password', requireLogin, (req, res) => {
  res.render('auth/change-password', { title: 'Change password', error: null, forced: req.user!.mustChangePassword, nav: null });
});

authRouter.post('/account/password', requireLogin, async (req, res) => {
  const user = req.user!;
  const render = (error: string): void => {
    res.status(400).render('auth/change-password', { title: 'Change password', error, forced: user.mustChangePassword, nav: null });
  };
  const parsed = passwordSchema.safeParse(req.body);
  if (!parsed.success) {
    render('Fill in all three fields.');
    return;
  }
  const { current_password: current, new_password: next, confirm_password: confirm } = parsed.data;
  const row = await queryOne<{ password_hash: string; dob: string | null; doj: string | null }>(
    `SELECT u.password_hash, s.date_of_birth AS dob, f.date_of_joining AS doj
       FROM app_user u LEFT JOIN student s USING (student_id) LEFT JOIN faculty f USING (faculty_id)
      WHERE u.user_id = $1`, [user.userId]);
  if (!row || !(await verifyPassword(current, row.password_hash))) {
    render('Your current password is not correct.');
    return;
  }
  if (next !== confirm) {
    render('The new passwords do not match.');
    return;
  }
  const initial = row.dob ?? row.doj;
  const problem = checkNewPassword(next, [user.loginId, current, initial ? initialPassword(initial) : '']);
  if (problem) {
    render(problem);
    return;
  }
  await query('UPDATE app_user SET password_hash = $2, must_change_password = false, password_changed_at = now() WHERE user_id = $1',
    [user.userId, await hashPassword(next)]);
  await audit(req, { action: 'PASSWORD_CHANGE', entity: 'app_user', entityId: user.userId });
  flash(req, 'success', 'Your password has been changed.');
  res.redirect(homeFor(user.role));
});
