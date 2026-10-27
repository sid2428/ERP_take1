import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const views = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../views');
const { renderFile } = createRequire(import.meta.url)('ejs') as {
  renderFile: (filename: string, data: Record<string, unknown>) => Promise<string>;
};

describe('shared UI kit', () => {
  it('renders every reusable component with labels and escaped content', async () => {
    const html = await renderFile(path.join(views, 'admin/ui.ejs'), {
      appName: 'PICT ERP', title: 'Shared UI kit', currentSession: null, flash: null,
      user: null, nav: null,
    });
    expect(html).toContain('Enrollment trend, sample values');
    expect(html).toContain('aria-label="Resolved: 76%"');
    expect(html).toContain('Computer Engineering');
    expect(html).toContain('Grievance assigned');
    expect(html).toContain('No notices yet');
    expect(html).toContain('role="status"');
  });

  it('handles flat trend data without invalid SVG coordinates', async () => {
    const html = await renderFile(path.join(views, 'partials/sparkline.ejs'), {
      label: 'Flat & safe', values: [4, 4],
    });
    expect(html).toContain('aria-label="Flat &amp; safe"');
    expect(html).toContain('4,30 116,30');
    expect(html).not.toContain('NaN');
  });
});
