import { describe, expect, it } from 'vitest';
import { escapeCsvCell } from '../../src/lib/csv.js';

describe('CSV cell escaping', () => {
  it.each(['=1+1', '+SUM(A1:A2)', '-1+2', '@command'])('neutralizes formula-leading value %s', value => {
    expect(escapeCsvCell(value)).toBe(`"'${value}"`);
  });

  it('quotes values and doubles embedded quotes', () => {
    expect(escapeCsvCell('Company "A", Inc.')).toBe('"Company ""A"", Inc."');
  });
});
