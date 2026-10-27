/** Return a rounded placement percentage; zero active students is defined as 0%. */
export function placementPercentage(placed: number, active: number): number {
  if (!Number.isFinite(placed) || !Number.isFinite(active) || active <= 0) return 0;
  return Math.round((placed / active) * 10_000) / 100;
}

export function chartBarPercent(value: number, maximum: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(maximum) || value <= 0 || maximum <= 0) return 0;
  return Math.min(100, value / maximum * 100);
}
