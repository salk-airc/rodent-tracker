/**
 * Minimal multi-sheet XLSX writer built on the existing zip dependency.
 * It writes frozen headers, column widths, typed booleans, and numeric cells.
 */

import { zipSync, strToU8 } from 'fflate';
import { validateTableShape, type Table } from './table';

/** Excel's own limits. Exceeding them produces a file Excel refuses to open. */
const MAX_ROWS = 1_048_576;
const MAX_SHEET_NAME = 31;

export interface XlsxOptions {
  /** Written into the workbook's document properties. */
  readonly creator?: string;
  /** Override only when a caller needs byte-for-byte reproducible output. */
  readonly createdAt?: Date;
}

export function toXlsx(tables: ReadonlyArray<Table>, opts: XlsxOptions = {}): Uint8Array {
  for (const table of tables) validateTableShape(table);
  const sheets = tables.map((t, i) => ({ table: t, name: safeSheetName(t.name, i, tables) }));
  const createdAt = opts.createdAt ?? new Date();

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypes(sheets.length)),
    '_rels/.rels': strToU8(rootRels()),
    'docProps/core.xml': strToU8(coreProps(opts.creator ?? 'Barnes Maze Analyzer', createdAt)),
    'docProps/app.xml': strToU8(appProps()),
    'xl/workbook.xml': strToU8(workbook(sheets.map((s) => s.name))),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRels(sheets.length)),
    'xl/styles.xml': strToU8(styles()),
  };

  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(worksheet(s.table));
  });

  // These workbooks are mostly repetitive markup, so deflate takes them to
  // roughly a tenth the size of a stored zip.
  // ZIP timestamps have no time zone. Fix the container timestamp; the actual
  // creation time remains in docProps/core.xml as UTC.
  return zipSync(files, { level: 6, mtime: new Date(1980, 0, 1) });
}

/**
 * Sheet names have rules that are easy to trip over: 31 characters, none of
 * `: \ / ? * [ ]`, and no duplicates. A workbook that breaks them opens as
 * "unreadable content" with no clue why.
 */
function safeSheetName(name: string, index: number, all: ReadonlyArray<Table>): string {
  const clean = (s: string) => s.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, MAX_SHEET_NAME);
  let s = clean(name) || `Sheet${index + 1}`;
  const earlier = all.slice(0, index).map((t) => clean(t.name));
  if (earlier.includes(s)) {
    const suffix = ` (${index + 1})`;
    s = s.slice(0, MAX_SHEET_NAME - suffix.length) + suffix;
  }
  return s;
}

function worksheet(table: Table): string {
  const rowCount = Math.min(table.rows.length + 1, MAX_ROWS);
  const widths = columnWidths(table);
  const lastCol = colName(table.columns.length);

  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  parts.push(
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
  );
  parts.push(`<dimension ref="A1:${lastCol}${rowCount}"/>`);
  // Freeze the header so a 60-row cohort table stays readable when scrolled.
  parts.push(
    '<sheetViews><sheetView workbookViewId="0">' +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '</sheetView></sheetViews>',
  );
  parts.push('<sheetFormatPr defaultRowHeight="15"/>');
  parts.push('<cols>');
  widths.forEach((w, i) => parts.push(`<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`));
  parts.push('</cols>');
  parts.push('<sheetData>');

  parts.push('<row r="1">');
  table.columns.forEach((c, i) => {
    parts.push(`<c r="${colName(i + 1)}1" t="inlineStr" s="1"><is><t xml:space="preserve">${xml(c)}</t></is></c>`);
  });
  parts.push('</row>');

  for (let r = 0; r < table.rows.length && r + 2 <= MAX_ROWS; r++) {
    const row = table.rows[r]!;
    parts.push(`<row r="${r + 2}">`);
    for (let c = 0; c < row.length; c++) {
      const ref = `${colName(c + 1)}${r + 2}`;
      const v = row[c];
      if (v === null || v === undefined || v === '') continue;
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) continue;
        parts.push(`<c r="${ref}"><v>${v}</v></c>`);
      } else if (typeof v === 'boolean') {
        // A real boolean, so a filter offers TRUE/FALSE rather than free text.
        parts.push(`<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`);
      } else {
        parts.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`);
      }
    }
    parts.push('</row>');
  }

  parts.push('</sheetData>');
  parts.push(`<autoFilter ref="A1:${lastCol}${rowCount}"/>`);
  parts.push('</worksheet>');
  return parts.join('');
}

/**
 * Column widths from the widest of the first couple of hundred cells, capped.
 *
 * The evidence and explanation columns hold whole sentences. Sizing them to
 * content would make a column three screens wide; leaving them at the default
 * would hide all of it. Sixty characters is the readable compromise.
 */
function columnWidths(table: Table): number[] {
  const widths = table.columns.map((c) => c.length + 2);
  const sample = Math.min(table.rows.length, 200);
  for (let r = 0; r < sample; r++) {
    const row = table.rows[r]!;
    for (let c = 0; c < row.length; c++) {
      const len = String(row[c] ?? '').length + 2;
      if (len > (widths[c] ?? 0)) widths[c] = len;
    }
  }
  return widths.map((w) => Math.min(Math.max(w, 8), 60));
}

function colName(n: number): string {
  let s = '';
  let v = n;
  while (v > 0) {
    const rem = (v - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    v = Math.floor((v - 1) / 26);
  }
  return s;
}

/** Escape XML and remove XML 1.0 control characters. */
function xml(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 && ch !== '\t' && ch !== '\n' && ch !== '\r') continue;
    if (code === 0x7f) continue;
    switch (ch) {
      case '&': out += '&amp;'; break;
      case '<': out += '&lt;'; break;
      case '>': out += '&gt;'; break;
      case '"': out += '&quot;'; break;
      default: out += ch;
    }
  }
  return out;
}

function contentTypes(sheetCount: number): string {
  const sheets = Array.from(
    { length: sheetCount },
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ` +
      'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
  ).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    sheets +
    '</Types>'
  );
}

function rootRels(): string {
  const ns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="${ns}/officeDocument" Target="xl/workbook.xml"/>` +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    `<Relationship Id="rId3" Type="${ns}/extended-properties" Target="docProps/app.xml"/>` +
    '</Relationships>'
  );
}

function workbook(names: ReadonlyArray<string>): string {
  const sheets = names.map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheets}</sheets></workbook>`
  );
}

function workbookRels(sheetCount: number): string {
  const ns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const sheets = Array.from(
    { length: sheetCount },
    (_, i) => `<Relationship Id="rId${i + 1}" Type="${ns}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  ).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets +
    `<Relationship Id="rId${sheetCount + 1}" Type="${ns}/styles" Target="styles.xml"/>` +
    '</Relationships>'
  );
}

function styles(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
    // Readers warn about a workbook with no named default style, so declare one.
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>'
  );
}

function coreProps(creator: string, createdAt: Date): string {
  const now = createdAt.toISOString().replace(/\.\d+Z$/, 'Z');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:creator>${xml(creator)}</dc:creator><cp:lastModifiedBy>${xml(creator)}</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
    '</cp:coreProperties>'
  );
}

function appProps(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
    '<Application>Barnes Maze Analyzer</Application></Properties>'
  );
}
