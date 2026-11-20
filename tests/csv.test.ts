import { describe, expect, it } from 'vitest';
import { toCsv } from '../src/io/csv';
import { parseCsv } from '../src/paradigms/barnes/io/pose';
import type { Table } from '../src/io/table';

describe('CSV output', () => {
  it('starts with the header and keeps every row rectangular', () => {
    const table: Table = {
      name: 'test',
      description: 'A description, with a comma, belongs outside the data rows.',
      columns: ['animal', 'value', 'note'],
      rows: [
        ['M1', 4, null],
        ['M2', Number.NaN, '=SUM(A1:A2)'],
      ],
    };

    const csv = toCsv(table);
    expect(csv.startsWith('\ufeff')).toBe(true);
    const rows = parseCsv(csv.slice(1));

    expect(rows[0]).toEqual(table.columns);
    expect(rows.every((row) => row.length === table.columns.length)).toBe(true);
    expect(rows[1]).toEqual(['M1', '4', '']);
    expect(rows[2]).toEqual(['M2', '', "'=SUM(A1:A2)"]);
  });
});
