import { describe, expect, it } from 'vitest';
import { placementAdminRouter } from '../../src/routes/placement-routes.js';

describe('placement drive route schema initialization', () => {
  it('constructs and registers the admin drive edit route', () => {
    const router = placementAdminRouter as unknown as {
      stack: Array<{ route?: { path?: string; methods?: Record<string, boolean> } }>;
    };

    expect(router.stack.some(layer => layer.route?.path === '/drives/:id/edit' && layer.route.methods?.post)).toBe(true);
  });
});
