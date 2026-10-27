/** Quote a CSV cell and neutralize spreadsheet formula prefixes. */
export function escapeCsvCell(value: unknown): string {
  let cell = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  return `"${cell.replace(/"/g, '""')}"`;
}
