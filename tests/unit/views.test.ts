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

describe('error page rendering', () => {
  it('renders when no user is provided and keeps the anonymous layout', async () => {
    const html = await renderFile(path.join(views, 'error.ejs'), {
      appName: 'PICT ERP',
      title: 'Error',
      status: 500,
      message: 'Something went wrong on our side. Please try again.',
      nav: null,
      currentSession: null,
      flash: null,
    });

    expect(html).toContain('Something went wrong');
    expect(html).toContain('Go to my dashboard');
    expect(html).not.toContain('id="sidebar"');
    expect(html).not.toContain('class="me-menu"');
  });

  it('keeps role navigation and account actions for a signed-in user', async () => {
    const html = await renderFile(path.join(views, 'error.ejs'), {
      appName: 'PICT ERP',
      title: 'Error',
      status: 500,
      message: 'Something went wrong on our side. Please try again.',
      user: { role: 'student', displayName: 'Test Student', loginId: 'STU-TEST' },
      NAV,
      fmt,
      nav: null,
      currentSession: null,
      flash: null,
      csrfToken: 'test-token',
    });

    expect(html).toContain('id="sidebar"');
    expect(html).toContain('href="/student/curriculum"');
    expect(html).toContain('STU-TEST');
    expect(html).toContain('action="/logout"');
  });
});
