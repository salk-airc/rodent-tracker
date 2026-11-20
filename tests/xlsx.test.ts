import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { strFromU8, unzipSync } from 'fflate';
import { toXlsx } from '../src/io/xlsx';
import type { Table } from '../src/paradigms/barnes/io/tables';

const table: Table = {
  name: 'Results',
  description: 'test',
  columns: ['animal', 'observed'],
  rows: [['M1', true]],
};

describe('XLSX reproducibility', () => {
  it('is byte-for-byte stable when the caller fixes the creation time', () => {
    const options = { creator: 'test', createdAt: new Date('2000-01-01T00:00:00.000Z') };
    expect(toXlsx([table], options)).toEqual(toXlsx([table], options));
  });

  it('keeps identical bytes across time zones and preserves the actual creation time', () => {
    const createdAt = '2026-03-08T02:30:00.000Z';
    const workbooks = ['UTC', 'America/Los_Angeles', 'Asia/Kathmandu'].map((timeZone) => {
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
        import { toXlsx } from './src/io/xlsx';
        process.stdout.write(toXlsx([${JSON.stringify(table)}], {
          createdAt: new Date('${createdAt}'),
        }));
      `], { env: { ...process.env, TZ: timeZone } });
      expect(result.status, result.stderr.toString()).toBe(0);
      return result.stdout;
    });
    expect(workbooks[1]).toEqual(workbooks[0]);
    expect(workbooks[2]).toEqual(workbooks[0]);
    const properties = strFromU8(unzipSync(workbooks[0]!)['docProps/core.xml']!);
    expect(properties).toContain('2026-03-08T02:30:00Z');
  });

  it('refuses a table whose rows do not match its headers', () => {
    const malformed: Table = { ...table, rows: [['M1']] };
    expect(() => toXlsx([malformed])).toThrow(/1 cells for 2 columns/);
  });
});
