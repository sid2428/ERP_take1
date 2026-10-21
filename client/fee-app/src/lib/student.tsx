import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getStudent } from './api';
import type { Student } from '../types';

const Ctx = createContext<Student | null>(null);
export const useStudent = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStudent must be used inside <StudentProvider>');
  return s;
};

export function StudentProvider({ children }: { children: ReactNode }) {
  const [student, setStudent] = useState<Student | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { getStudent().then(setStudent).catch((e) => setError(e.message)); }, []);
  if (error) return <div className="p-8 text-err-ink">Could not load your profile: {error}</div>;
  if (!student) return <div className="p-8 text-muted">Loading…</div>;
  return <Ctx.Provider value={student}>{children}</Ctx.Provider>;
}
