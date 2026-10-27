export const DEFAULT_PLACEMENT_DRIVE_PAGE_SIZE = 20;
export const MAX_PLACEMENT_DRIVE_PAGE_SIZE = 50;

export type PlacementDrivePagination = { page: number; pageSize: number };

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Parse untrusted query values; the database query clamps page to the last available page. */
export function parsePlacementDrivePagination(pageValue: unknown, pageSizeValue: unknown): PlacementDrivePagination {
  const page = positiveInteger(pageValue) ?? 1;
  const requestedSize = positiveInteger(pageSizeValue) ?? DEFAULT_PLACEMENT_DRIVE_PAGE_SIZE;
  return { page, pageSize: Math.min(requestedSize, MAX_PLACEMENT_DRIVE_PAGE_SIZE) };
}
