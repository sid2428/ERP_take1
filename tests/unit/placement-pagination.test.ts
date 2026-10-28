import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLACEMENT_DRIVE_PAGE_SIZE,
  MAX_PLACEMENT_DRIVE_PAGE_SIZE,
  parsePlacementDrivePagination,
} from '../../src/lib/placement-pagination.js';

describe('placement drive pagination input', () => {
  it('uses the first page and default page size when absent', () => {
    expect(parsePlacementDrivePagination(undefined, undefined)).toEqual({ page: 1, pageSize: DEFAULT_PLACEMENT_DRIVE_PAGE_SIZE });
  });

  it('accepts positive integer boundaries and caps page size', () => {
    expect(parsePlacementDrivePagination('2', '1')).toEqual({ page: 2, pageSize: 1 });
    expect(parsePlacementDrivePagination('3', String(MAX_PLACEMENT_DRIVE_PAGE_SIZE))).toEqual({ page: 3, pageSize: MAX_PLACEMENT_DRIVE_PAGE_SIZE });
    expect(parsePlacementDrivePagination('3', '500')).toEqual({ page: 3, pageSize: MAX_PLACEMENT_DRIVE_PAGE_SIZE });
  });

  it('safely defaults malformed, zero, negative, fractional, and unsafe integers', () => {
    for (const invalid of ['', '0', '-2', '1.5', 'nope', '9007199254740992']) {
      expect(parsePlacementDrivePagination(invalid, invalid)).toEqual({ page: 1, pageSize: DEFAULT_PLACEMENT_DRIVE_PAGE_SIZE });
    }
    expect(parsePlacementDrivePagination(['2'], ['10'])).toEqual({ page: 1, pageSize: DEFAULT_PLACEMENT_DRIVE_PAGE_SIZE });
  });
});
