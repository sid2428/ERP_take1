import 'express-session';

export type Role = 'student' | 'faculty' | 'admin';

export interface CurrentUser {
  userId: number;
  loginId: string;
  role: Role;
  studentId: number | null;
  facultyId: number | null;
  displayName: string;
  deptId: string | null;
  /** Faculty who head their department (they see the department placement report). */
  isHod: boolean;
  mustChangePassword: boolean;
}

export interface Flash { type: 'success' | 'error' | 'info'; text: string; }

declare module 'express-session' {
  interface SessionData {
    userId?: number;
    csrfToken?: string;
    flash?: Flash;
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: CurrentUser;
    }
  }
}
