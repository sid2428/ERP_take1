import type { Role } from '../types.js';

export interface NavItem { key: string; label: string; href: string; icon: string; }
export interface NavGroup { label: string; items: NavItem[]; }

/** Sidebar per role. Only modules that are built appear here (no dead links). */
export const NAV: Record<Role, NavGroup[]> = {
  student: [
    {
      label: 'OVERVIEW', items: [
        { key: 'dashboard', label: 'Dashboard', href: '/student', icon: 'home' },
        { key: 'notices', label: 'Notices', href: '/student/notices', icon: 'bell' },
      ],
    },
    {
      label: 'ACADEMICS', items: [
        { key: 'curriculum', label: 'Curriculum', href: '/student/curriculum', icon: 'list' },
        { key: 'offerings', label: 'Course offerings', href: '/student/offerings', icon: 'book' },
        { key: 'electives', label: 'Electives', href: '/student/electives', icon: 'list' },
      ],
    },
    {
      label: 'RECORDS', items: [
        { key: 'profile', label: 'Profile', href: '/student/profile', icon: 'user' },
        { key: 'fee', label: 'Fees & D-Wallet', href: '/student/fee', icon: 'wallet' },
        { key: 'grievances', label: 'Grievances', href: '/student/grievances', icon: 'alert' },
      ],
    },
  ],
  faculty: [
    {
      label: 'OVERVIEW', items: [
        { key: 'dashboard', label: 'Dashboard', href: '/faculty', icon: 'home' },
        { key: 'notices', label: 'Notices', href: '/faculty/notices', icon: 'bell' },
      ],
    },
    { label: 'TEACHING', items: [{ key: 'classes', label: 'My classes', href: '/faculty/classes', icon: 'users' }] },
    {
      label: 'RECORDS', items: [
        { key: 'profile', label: 'Profile', href: '/faculty/profile', icon: 'user' },
        { key: 'grievances', label: 'Grievances', href: '/faculty/grievances', icon: 'alert' },
      ],
    },
  ],
  admin: [
    {
      label: 'OVERVIEW', items: [
        { key: 'dashboard', label: 'Dashboard', href: '/admin', icon: 'home' },
        { key: 'inbox', label: 'Inbox', href: '/admin/inbox', icon: 'bell' },
      ],
    },
    {
      label: 'ACADEMIC STRUCTURE', items: [
        { key: 'departments', label: 'Departments', href: '/admin/departments', icon: 'building' },
        { key: 'programs', label: 'Programs & curriculum', href: '/admin/programs', icon: 'list' },
        { key: 'courses', label: 'Course catalog', href: '/admin/courses', icon: 'book' },
        { key: 'sessions', label: 'Academic sessions', href: '/admin/sessions', icon: 'calendar' },
        { key: 'sections', label: 'Divisions & sections', href: '/admin/sections', icon: 'users' },
        { key: 'electives', label: 'Electives', href: '/admin/electives', icon: 'list' },
      ],
    },
    {
      label: 'PEOPLE', items: [
        { key: 'students', label: 'Students', href: '/admin/students', icon: 'user' },
        { key: 'faculty', label: 'Faculty', href: '/admin/faculty', icon: 'briefcase' },
      ],
    },
    {
      label: 'COMMUNICATION', items: [
        { key: 'notices', label: 'Notices', href: '/admin/notices', icon: 'bell' },
        { key: 'grievances', label: 'Grievances', href: '/admin/grievances', icon: 'alert' },
      ],
    },
    { label: 'SYSTEM', items: [{ key: 'audit', label: 'Audit log', href: '/admin/audit', icon: 'shield' }] },
  ],
};
