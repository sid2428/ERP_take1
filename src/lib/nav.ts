import type { Role } from '../types.js';

export interface NavItem { key: string; label: string; href: string; icon: string; }
export interface NavGroup { label: string; items: NavItem[]; }

/** Sidebar per role. Only modules that are built appear here (no dead links). */
export const NAV: Record<Role, NavGroup[]> = {
  student: [
    { label: 'OVERVIEW', items: [{ key: 'dashboard', label: 'Dashboard', href: '/student', icon: 'home' }] },
    {
      label: 'ACADEMICS', items: [
        { key: 'curriculum', label: 'Curriculum', href: '/student/curriculum', icon: 'list' },
        { key: 'offerings', label: 'Course offerings', href: '/student/offerings', icon: 'book' },
      ],
    },
    {
      label: 'FINANCE', items: [
        { key: 'fee', label: 'Fees & D-Wallet', href: '/student/fee', icon: 'wallet' },
      ],
    },
    { label: 'RECORDS', items: [{ key: 'profile', label: 'Profile', href: '/student/profile', icon: 'user' }] },
  ],
  faculty: [
    { label: 'OVERVIEW', items: [{ key: 'dashboard', label: 'Dashboard', href: '/faculty', icon: 'home' }] },
    { label: 'TEACHING', items: [{ key: 'classes', label: 'My classes', href: '/faculty/classes', icon: 'users' }] },
    { label: 'RECORDS', items: [{ key: 'profile', label: 'Profile', href: '/faculty/profile', icon: 'user' }] },
  ],
  admin: [
    { label: 'OVERVIEW', items: [{ key: 'dashboard', label: 'Dashboard', href: '/admin', icon: 'home' }] },
    {
      label: 'ACADEMIC STRUCTURE', items: [
        { key: 'departments', label: 'Departments', href: '/admin/departments', icon: 'building' },
        { key: 'programs', label: 'Programs & curriculum', href: '/admin/programs', icon: 'list' },
        { key: 'courses', label: 'Course catalog', href: '/admin/courses', icon: 'book' },
        { key: 'sessions', label: 'Academic sessions', href: '/admin/sessions', icon: 'calendar' },
        { key: 'sections', label: 'Divisions & sections', href: '/admin/sections', icon: 'users' },
      ],
    },
    {
      label: 'PEOPLE', items: [
        { key: 'students', label: 'Students', href: '/admin/students', icon: 'user' },
        { key: 'faculty', label: 'Faculty', href: '/admin/faculty', icon: 'briefcase' },
      ],
    },
    { label: 'SYSTEM', items: [{ key: 'audit', label: 'Audit log', href: '/admin/audit', icon: 'shield' }] },
  ],
};
