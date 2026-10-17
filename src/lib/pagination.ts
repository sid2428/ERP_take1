export const PAGE_SIZE = 25;

export interface Page { page: number; offset: number; limit: number; }

export function parsePage(value: unknown): Page {
  const n = Number(value);
  const page = Number.isInteger(n) && n > 0 ? Math.min(n, 10_000) : 1;
  return { page, offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE };
}

export interface PageInfo { page: number; pages: number; total: number; from: number; to: number; }

export function pageInfo(page: Page, total: number): PageInfo {
  const pages = Math.max(1, Math.ceil(total / page.limit));
  return { page: page.page, pages, total, from: total ? page.offset + 1 : 0, to: Math.min(total, page.offset + page.limit) };
}

/** Build a query string from the current filters, overriding some keys (used by pager links). */
export function withQuery(base: Record<string, unknown>, overrides: Record<string, unknown> = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...overrides })) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}
