import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { fmt } from '../../src/lib/format.js';
import { NAV } from '../../src/lib/nav.js';

const views = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../views');
const { renderFile } = createRequire(import.meta.url)('ejs') as {
  renderFile: (filename: string, data: Record<string, unknown>) => Promise<string>;
};

const adminUser = { role: 'admin', displayName: 'Administrator', loginId: 'admin' };
const studentUser = { role: 'student', displayName: 'Jane Doe', loginId: 'STU202600004' };
const facultyUser = { role: 'faculty', displayName: 'Dr. Smith', loginId: 'FAC001', isHod: true, deptId: 'COMP' };

const baseData = {
  appName: 'PICT ERP',
  NAV,
  fmt,
  currentSession: { session_name: '2025-26 Term I', session_id: 'AY2526T1' },
  csrfToken: 'test-token',
  flash: null,
};

describe('TNP Redesigned EJS Templates Compilation and Rendering', () => {
  it('renders admin placement dashboard with metrics and recent drives', async () => {
    const html = await renderFile(path.join(views, 'admin/placement-dashboard.ejs'), {
      ...baseData,
      title: 'Placement',
      nav: 'placement',
      user: adminUser,
      overview: {
        active_students: 1200,
        placed_students: 950,
        total_offers: 1100,
        accepted_fulltime_offers: 900,
        accepted_internships: 150,
        highest_package_lpa: 44.5,
        median_package_lpa: 14.0,
      },
      drives: [
        {
          drive_id: 101,
          title: 'Google SDE Campus Drive',
          company_name: 'Google India',
          role_title: 'Software Engineer',
          drive_type: 'FullTime',
          package_lpa: 32.5,
          stipend_monthly: null,
          status: 'Open',
          deadline: new Date(Date.now() + 86400000).toISOString(),
          applicants: 42,
        },
      ],
    });

    expect(html).toContain('Training &amp; Placement');
    expect(html).toContain('Google SDE Campus Drive');
    expect(html).toContain('32.5 LPA');
    expect(html).toContain('Placement Overview');
  });

  it('renders admin placement companies directory', async () => {
    const html = await renderFile(path.join(views, 'admin/placement-companies.ejs'), {
      ...baseData,
      title: 'Companies',
      nav: 'placement',
      user: adminUser,
      companies: [
        {
          company_id: 1,
          company_name: 'Microsoft India',
          industry: 'Technology',
          website_url: 'https://microsoft.com',
          headquarters: 'Hyderabad',
          drive_count: 5,
          is_active: true,
        },
      ],
    });

    expect(html).toContain('Microsoft India');
    expect(html).toContain('Recruiting Companies');
    expect(html).toContain('Register New Corporate Partner');
  });

  it('renders admin placement company edit form', async () => {
    const html = await renderFile(path.join(views, 'admin/placement-company-edit.ejs'), {
      ...baseData,
      title: 'Edit company',
      nav: 'placement',
      user: adminUser,
      company: {
        company_id: 1,
        company_name: 'Microsoft India',
        industry: 'Technology',
        website_url: 'https://microsoft.com',
        contact_name: 'HR Team',
        contact_email: 'recruiter@microsoft.com',
        contact_phone: '+91 9999999999',
        headquarters: 'Hyderabad',
        description: 'Global tech leader.',
        is_active: true,
      },
    });

    expect(html).toContain('Edit Corporate Partner');
    expect(html).toContain('Microsoft India');
  });

  it('renders admin placement drive create and edit form', async () => {
    const html = await renderFile(path.join(views, 'admin/placement-drive-form.ejs'), {
      ...baseData,
      title: 'Create drive',
      nav: 'placement',
      user: adminUser,
      companies: [{ company_id: 1, company_name: 'Google' }],
      programs: [{ program_id: 'COMP-BTECH', program_name: 'Computer Engineering' }],
      errors: null,
      isEdit: false,
      action: '/admin/placement/drives',
      form: {},
    });

    expect(html).toContain('Create Placement Drive');
    expect(html).toContain('Google');
    expect(html).toContain('COMP-BTECH');
  });

  it('renders admin placement drive detail with rounds and applicants', async () => {
    const html = await renderFile(path.join(views, 'admin/placement-drive-detail.ejs'), {
      ...baseData,
      title: 'Drive Detail',
      nav: 'placement',
      user: adminUser,
      drive: {
        drive_id: 1,
        company_name: 'Amazon',
        title: 'Amazon SDE 2026',
        role_title: 'SDE-1',
        drive_type: 'FullTime',
        package_lpa: 28.0,
        stipend_monthly: null,
        status: 'Open',
        opens_at: new Date().toISOString(),
        deadline: new Date(Date.now() + 86400000).toISOString(),
        min_year: 4,
        min_cgpa: 7.5,
        max_active_backlogs: 0,
        min_attendance_pct: 75.0,
        job_location: 'Pune / Hyderabad',
        description: 'Job details here.',
      },
      rounds: [
        {
          round_id: 10,
          sequence_no: 1,
          round_name: 'Online Coding Assessment',
          description: 'HackerRank test',
          status: 'Completed',
          scheduled_at: new Date().toISOString(),
          scheduled_local: '2026-10-30T10:00',
        },
      ],
      applicants: [
        {
          application_id: 50,
          student_number: 'STU202600004',
          first_name: 'Jane',
          last_name: 'Doe',
          program_name: 'Computer Engineering',
          year_of_study: 4,
          applied_at: new Date().toISOString(),
          status: 'Shortlisted',
          next_statuses: ['Selected', 'Rejected'],
          rounds: [{ round: 'Online Coding Assessment', result: 'Passed', remarks: 'Full score' }],
          offer_id: null,
          offer_status: null,
          package_lpa: null,
          stipend_monthly: null,
        },
      ],
    });

    expect(html).toContain('Amazon SDE 2026');
    expect(html).toContain('Online Coding Assessment');
    expect(html).toContain('Jane Doe');
    expect(html).toContain('STU202600004');
  });

  it('renders admin placement statistics page', async () => {
    const html = await renderFile(path.join(views, 'admin/placement-statistics.ejs'), {
      ...baseData,
      title: 'Placement statistics',
      nav: 'placement',
      user: adminUser,
      overview: {
        overall_placement_pct: 85.5,
        active_students: 1200,
        placed_students: 1026,
        total_offers: 1350,
        highest_package_lpa: 48.0,
        average_package_lpa: 14.8,
        median_package_lpa: 13.5,
        accepted_fulltime_offers: 1026,
        accepted_internships: 200,
      },
      byDepartment: [
        {
          dept_name: 'Computer Engineering',
          active_students: 400,
          placed_students: 380,
          placed_pct: 95.0,
          highest_package_lpa: 48.0,
          bar_pct: 95.0,
        },
      ],
      packageDistribution: [
        { label: '20+ LPA', offer_count: 85, bar_pct: 100 },
        { label: '15–<20 LPA', offer_count: 120, bar_pct: 80 },
      ],
      companyOffers: [
        {
          company_name: 'Adobe',
          total_offers: 15,
          accepted_fulltime: 14,
          accepted_internships: 1,
        },
      ],
      hasPackageData: true,
    });

    expect(html).toContain('Highest package');
    expect(html).toContain('Company-wise offers');
    expect(html).toContain('Computer Engineering');
  });

  it('renders student placement dashboard', async () => {
    const html = await renderFile(path.join(views, 'student/placement-dashboard.ejs'), {
      ...baseData,
      title: 'Placement',
      nav: 'placement',
      user: studentUser,
      summary: {
        open_drives: 8,
        eligible_drives: 6,
        applications: 3,
        in_progress: 2,
        pending_offers: 1,
        profile_completion_pct: 80,
      },
      profile: {
        skills: 'TypeScript, PostgreSQL, React',
        resume_url: 'https://example.com/resume.pdf',
        linkedin_url: 'https://linkedin.com/in/janedoe',
      },
      status: {
        is_placed: true,
        best_offer_lpa: 18.0,
      },
    });

    expect(html).toContain('Training &amp; Placement');
    expect(html).toContain('Placed Student');
    expect(html).toContain('18 LPA');
    expect(html).toContain('Open Drives');
  });

  it('renders student placement profile page', async () => {
    const html = await renderFile(path.join(views, 'student/placement-profile.ejs'), {
      ...baseData,
      title: 'Placement profile',
      nav: 'placement',
      user: studentUser,
      profile: {
        skills: 'Node.js, Express, Docker',
        resume_url: 'https://example.com/resume.pdf',
        linkedin_url: 'https://linkedin.com/in/janedoe',
        github_url: 'https://github.com/janedoe',
        portfolio_url: 'https://janedoe.dev',
      },
      errors: null,
    });

    expect(html).toContain('Placement profile');
    expect(html).toContain('Technical Skills');
    expect(html).toContain('https://github.com/janedoe');
  });

  it('renders student placement drives listing', async () => {
    const html = await renderFile(path.join(views, 'student/placement-drives.ejs'), {
      ...baseData,
      title: 'Placement drives',
      nav: 'placement',
      user: studentUser,
      drives: [
        {
          drive_id: 1,
          title: 'Infosys Specialist Programmer',
          role_title: 'Specialist Programmer',
          company_name: 'Infosys',
          drive_type: 'FullTime',
          package_lpa: 9.5,
          stipend_monthly: null,
          min_year: 4,
          deadline: new Date(Date.now() + 86400000).toISOString(),
          drive_date: '2026-11-15',
          job_location: 'Pune',
          eligible: true,
          reasons: [],
          applied: false,
        },
      ],
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
      filters: { q: '', type: '', eligible: '' },
    });

    expect(html).toContain('Campus Recruitment Drives');
    expect(html).toContain('Infosys Specialist Programmer');
    expect(html).toContain('9.5 LPA');
    expect(html).toContain('Eligible');
  });

  it('renders student placement drive detail with apply button', async () => {
    const html = await renderFile(path.join(views, 'student/placement-drive.ejs'), {
      ...baseData,
      title: 'Drive Detail',
      nav: 'placement',
      user: studentUser,
      drive: {
        drive_id: 1,
        title: 'Infosys Specialist Programmer',
        role_title: 'Specialist Programmer',
        company_name: 'Infosys',
        drive_type: 'FullTime',
        package_lpa: 9.5,
        stipend_monthly: null,
        min_year: 4,
        min_cgpa: 7.0,
        max_active_backlogs: 0,
        min_attendance_pct: 75.0,
        deadline: new Date(Date.now() + 86400000).toISOString(),
        drive_date: '2026-11-15',
        job_location: 'Pune',
        description: 'Role overview.',
        programs: ['Computer Engineering', 'Information Technology'],
        eligible: true,
        reasons: [],
      },
      application: null,
    });

    expect(html).toContain('Infosys Specialist Programmer');
    expect(html).toContain('Apply Now');
    expect(html).toContain('9.5 LPA');
  });

  it('renders student placement applications page with rounds and offer', async () => {
    const html = await renderFile(path.join(views, 'student/placement-applications.ejs'), {
      ...baseData,
      title: 'My applications',
      nav: 'placement',
      user: studentUser,
      applications: [
        {
          application_id: 10,
          drive_id: 1,
          title: 'TCS Digital Recruitment',
          role_title: 'Digital Systems Engineer',
          company_name: 'TCS',
          drive_type: 'FullTime',
          applied_at: new Date().toISOString(),
          status: 'Applied',
          rounds: [
            { name: 'Results round', status: 'Pending', date: new Date().toISOString() },
          ],
          offer_id: 25,
          offer_status: 'Pending',
          package_lpa: 7.5,
          stipend_monthly: null,
          response_deadline: new Date(Date.now() + 86400000).toISOString(),
        },
      ],
    });

    expect(html).toContain('My placement applications');
    expect(html).toContain('Applied');
    expect(html).toContain('Results round');
    expect(html).toContain('Pending');
    expect(html).toContain('Accept Offer');
  });

  it('renders faculty department placement report', async () => {
    const html = await renderFile(path.join(views, 'faculty/placement-report.ejs'), {
      ...baseData,
      title: 'Department placement report',
      nav: 'placement',
      user: facultyUser,
      rows: [
        {
          program_id: 'COMP-BTECH',
          program_name: 'B.Tech Computer Engineering',
          active_students: 240,
          placed_students: 228,
          placed_pct: 95.0,
          highest_package_lpa: 44.0,
        },
      ],
    });

    expect(html).toContain('Department Placement Report');
    expect(html).toContain('B.Tech Computer Engineering');
    expect(html).toContain('95%');
    expect(html).toContain('44 LPA');
  });
});

