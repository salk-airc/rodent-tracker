/**
 * CSV writing.
 *
 * Excel-safe by default, which is not the same as RFC-4180-correct and matters
 * more here. Two specific hazards are handled: a leading `=`, `+`, `-` or `@`
 * makes Excel treat a cell as a formula, and a bare UTF-8 file makes Excel
 * mangle any non-ASCII character in an animal ID or a note.
 */

import { validateTableShape, type Table } from './table';

export interface CsvOptions {
  /** Prepend a byte-order mark so Excel reads UTF-8 correctly. Default true. */
  readonly bom?: boolean;
  readonly delimiter?: string;
}

const BOM = '﻿';

export function toCsv(table: Table, opts: CsvOptions = {}): string {
  validateTableShape(table);
  const delimiter = opts.delimiter ?? ',';
  const lines: string[] = [];
  lines.push(table.columns.map((c) => escapeCell(c, delimiter)).join(delimiter));
  for (const row of table.rows) lines.push(row.map((c) => escapeCell(c, delimiter)).join(delimiter));
  const text = `${lines.join('\r\n')}\r\n`;
  return opts.bom === false ? text : BOM + text;
}

function escapeCell(value: string | number | boolean | null | undefined, delimiter: string): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';

  let s = value;
  // Excel and Sheets treat a cell starting with any of these as a formula. A
  // note that begins with a minus sign should not become an error value.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (s.includes('"') || s.includes(delimiter) || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
