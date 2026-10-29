import { describe, expect, it } from 'vitest';
import { chartBarPercent, placementPercentage } from '../../src/lib/placement-stats.js';

describe('placement statistics calculations', () => {
  it('defines a zero active-student denominator as 0%', () => {
    expect(placementPercentage(0, 0)).toBe(0);
    expect(placementPercentage(3, 0)).toBe(0);
    expect(placementPercentage(0, 4)).toBe(0);
  });

  it('rounds the active-student placement rate to two decimals', () => {
    expect(placementPercentage(1, 3)).toBe(33.33);
    expect(placementPercentage(1, 8)).toBe(12.5);
  });

  it('scales chart bars safely for empty, zero and malformed counts', () => {
    expect(chartBarPercent(0, 0)).toBe(0);
    expect(chartBarPercent(3, 0)).toBe(0);
    expect(chartBarPercent(Number.NaN, 5)).toBe(0);
    expect(chartBarPercent(2, 4)).toBe(50);
    expect(chartBarPercent(5, 4)).toBe(100);
  });

  it('treats malformed branch counts as zero rather than exposing invalid percentages', () => {
    expect(placementPercentage(Number.NaN, 4)).toBe(0);
    expect(placementPercentage(2, Number.POSITIVE_INFINITY)).toBe(0);
  });
});
