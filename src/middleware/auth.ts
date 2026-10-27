import type { NextFunction, Request, Response } from 'express';
import { queryOne } from '../db.js';
import { forbidden } from '../lib/http-error.js';
import type { CurrentUser, Flash, Role } from '../types.js';

interface ProfileRow {
  user_id: number; login_id: string; role: Role; student_id: number | null; faculty_id: number | null;
  display_name: string; dept_id: string | null; must_change_password: boolean; is_active: boolean; is_hod: boolean;
}

export async function loadUser(userId: number): Promise<CurrentUser | null> {
  const row = await queryOne<ProfileRow>(
    `SELECT p.*, EXISTS (SELECT 1 FROM department d WHERE d.hod_faculty_id = p.faculty_id AND d.dept_id = p.dept_id) AS is_hod
     FROM v_user_profile p WHERE p.user_id = $1`, [userId]);
  if (!row || !row.is_active) return null;
  return {
    userId: row.user_id, loginId: row.login_id, role: row.role, studentId: row.student_id,
    facultyId: row.faculty_id, displayName: row.display_name, deptId: row.dept_id, isHod: row.is_hod,
    mustChangePassword: row.must_change_password,
  };
}

/** Attach the signed-in user (if any) and move the one-time flash message into the view. */
export async function currentUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.session.userId) {
    const user = await loadUser(req.session.userId);
    if (user) {
      req.user = user;
    } else {
      delete req.session.userId;      // account removed or deactivated since login
    }
  }
  res.locals.user = req.user ?? null;
  res.locals.flash = req.session.flash ?? null;
  delete req.session.flash;
  next();
}

export function flash(req: Request, type: Flash['type'], text: string): void {
  req.session.flash = { type, text };
}

export function requireLogin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    return;
  }
  if (req.user.mustChangePassword && !req.path.startsWith('/account/password')) {
    res.redirect('/account/password');
    return;
  }
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      next(forbidden());
      return;
    }
    next();
  };
}

export function homeFor(role: Role): string {
  return `/${role}`;
}
