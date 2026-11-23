/**
 * Paradigm-independent DeepLabCut and SLEAP analysis CSV import and export.
 *
 * `importPosePositions` produces `PositionSample[]` that feed straight into
 * `trackFromPositions(samples, arena)` for any arena paradigm (open field,
 * elevated plus maze, Y-maze, novel object, …). Barnes-specific `TrackObservation`
 * adaptation stays in `paradigms/barnes/io/pose.ts`.
 */

import { frameTime, type Point, type Timebase } from '../types';
import type { PositionSample } from '../tracking/arenaTrack';

export type PoseFormat = 'deeplabcut' | 'sleap-analysis-csv' | 'unknown';

export interface PoseColumnMapping {
  readonly column: string;
  readonly usedAs: 'nose' | 'body' | 'tail' | 'ignored';
}

export interface PoseImportOptions {
  /** Below this, a point is treated as not detected. Defaults to 0.6. */
  readonly minLikelihood?: number;
}

export interface PosePositionImportOptions extends PoseImportOptions {
  /** Video timebase to map frame indices to seconds. Takes precedence over `fps`. */
  readonly timebase?: Timebase;
  /** Constant frame rate used when `timebase` is omitted. Defaults to 30 fps. */
  readonly fps?: number;
  /** Require separate nose and body columns (default false for general arena scoring). */
  readonly requireNose?: boolean;
}

export interface PoseFrameRecord {
  readonly frame: number;
  readonly body: Point | null;
  readonly nose: Point | null;
  readonly tail: Point | null;
  readonly bodyConf: number;
  readonly noseConf: number;
  readonly tailConf: number;
}

export interface ParsedPoseCsv {
  readonly format: Exclude<PoseFormat, 'unknown'>;
  readonly frames: ReadonlyArray<PoseFrameRecord>;
  readonly mapping: ReadonlyArray<PoseColumnMapping>;
  readonly frameCount: number;
  readonly lowConfidenceFrames: number;
  readonly hasNose: boolean;
  readonly hasTail: boolean;
  readonly warnings: ReadonlyArray<string>;
}

export interface PosePositionsResult {
  readonly format: Exclude<PoseFormat, 'unknown'>;
  readonly samples: ReadonlyArray<PositionSample>;
  readonly mapping: ReadonlyArray<PoseColumnMapping>;
  readonly frameCount: number;
  readonly lowConfidenceFrames: number;
  readonly warnings: ReadonlyArray<string>;
}

export interface PoseExportOptions {
  readonly scorer?: string;
}

export interface PoseExportPoint {
  readonly frame: number;
  readonly body: Point | null;
  readonly nose: Point | null;
  readonly tail: Point | null;
  readonly confidence: number;
}

const NOSE_NAMES = /^(nose|snout|nose_?tip|head|headtip|head_?tip)$/i;
const BODY_NAMES = /^(body|body_?cent(er|re)|cent(er|re)|centroid|thorax|spine|spine1|trunk|mid|midback|back)$/i;
const TAIL_NAMES = /^(tail|tail_?base|tailbase|tail_?start|tailstart|tail1)$/i;

export function sniffPoseFormat(text: string): PoseFormat {
  const head = text.slice(0, 4000);
  const lines = head.split(/\r?\n/);
  if (lines.some((l) => /^\s*(scorer|individuals|bodyparts|coords)\s*,/i.test(l))) return 'deeplabcut';
  const first = lines[0] ?? '';
  if (/frame_idx/i.test(first) && /\.x\b/i.test(first)) return 'sleap-analysis-csv';
  return 'unknown';
}

/**
 * Import a DeepLabCut or SLEAP analysis CSV as `PositionSample[]` for any
 * arena paradigm (`trackFromPositions`).
 */
export function importPosePositions(text: string, options: PosePositionImportOptions = {}): PosePositionsResult {
  const parsed = parsePoseCsv(text, {
    ...(options.minLikelihood !== undefined ? { minLikelihood: options.minLikelihood } : {}),
    requireNose: options.requireNose ?? false,
  });
  const fps = options.fps ?? 30;
  if (!(fps > 0)) throw new RangeError('fps must be positive');
  const timeOf = (frame: number): number => {
    if (options.timebase && frame < options.timebase.ptsTicks.length) {
      return frameTime(options.timebase, frame);
    }
    return frame / fps;
  };
  const samples: PositionSample[] = parsed.frames.map((f) => {
    const present = f.body !== null;
    const confidence =
      f.tail && f.nose
        ? Math.min(f.noseConf, f.tailConf)
        : f.nose && f.body
          ? Math.min(f.noseConf, f.bodyConf)
          : present
            ? f.bodyConf
            : 0;
    return {
      frame: f.frame,
      timeS: timeOf(f.frame),
      body: f.body,
      nose: f.nose,
      tail: f.tail,
      confidence,
      provenance: 'imported',
    };
  });
  return {
    format: parsed.format,
    samples,
    mapping: parsed.mapping,
    frameCount: parsed.frameCount,
    lowConfidenceFrames: parsed.lowConfidenceFrames,
    warnings: parsed.warnings,
  };
}

/** Low-level parser shared by `importPosePositions` and paradigm-specific importers (e.g. Barnes). */
export function parsePoseCsv(
  text: string,
  options: PoseImportOptions & { readonly requireNose?: boolean } = {},
): ParsedPoseCsv {
  const format = sniffPoseFormat(text);
  switch (format) {
    case 'deeplabcut':
      return parseDeepLabCut(text, options);
    case 'sleap-analysis-csv':
      return parseSleapCsv(text, options);
    default:
      throw new Error(
        'Unsupported pose CSV. Use a DeepLabCut CSV or SLEAP analysis CSV. SLEAP .slp files are not supported; export CSV first.',
      );
  }
}

// ---------------------------------------------------------------------------

interface ColumnPlan {
  readonly mapping: PoseColumnMapping[];
  readonly nose: { x: number; y: number; conf: number } | null;
  readonly body: { x: number; y: number; conf: number } | null;
  readonly tail: { x: number; y: number; conf: number } | null;
}

function parseDeepLabCut(text: string, options: PoseImportOptions & { readonly requireNose?: boolean }): ParsedPoseCsv {
  const rows = parseCsv(text);
  const headerRows: string[][] = [];
  let firstData = 0;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const key = (rows[i]?.[0] ?? '').trim().toLowerCase();
    if (key === 'scorer' || key === 'individuals' || key === 'bodyparts' || key === 'coords') {
      headerRows.push(rows[i]!);
      firstData = i + 1;
    }
  }
  const bodyparts = headerRows.find((r) => r[0]?.trim().toLowerCase() === 'bodyparts');
  const coords = headerRows.find((r) => r[0]?.trim().toLowerCase() === 'coords');
  if (!bodyparts || !coords) {
    throw new Error('This DeepLabCut file is missing its "bodyparts" or "coords" header row.');
  }
  const individuals = headerRows.find((row) => row[0]?.trim().toLowerCase() === 'individuals');
  if (individuals) {
    const identities = new Set(individuals.slice(1).map((value) => value.trim()).filter(Boolean));
    if (identities.size > 1) {
      throw new Error(`Found ${identities.size} animals. Export one animal track and try again.`);
    }
  }

  const names = bodyparts.map((v, i) => (i === 0 ? '' : v.trim()));
  const kinds = coords.map((v, i) => (i === 0 ? '' : v.trim().toLowerCase()));
  const plan = planColumns(names, kinds, options.requireNose ?? false);
  return buildRecords(rows.slice(firstData), plan, options, 'deeplabcut', (row) => Number(row[0]));
}

function parseSleapCsv(text: string, options: PoseImportOptions & { readonly requireNose?: boolean }): ParsedPoseCsv {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) throw new Error('This SLEAP analysis CSV has no header row.');
  const frameCol = header.findIndex((h) => /^frame_idx$/i.test(h.trim()));
  if (frameCol < 0) throw new Error('This SLEAP analysis CSV has no frame_idx column.');

  const names: string[] = [];
  const kinds: string[] = [];
  for (const h of header) {
    const m = /^(.*)\.(x|y|score)$/i.exec(h.trim());
    if (m) {
      names.push(m[1]!);
      kinds.push(m[2]!.toLowerCase() === 'score' ? 'likelihood' : m[2]!.toLowerCase());
    } else {
      names.push('');
      kinds.push('');
    }
  }

  const plan = planColumns(names, kinds, options.requireNose ?? false);
  const trackCol = header.findIndex((h) => /^track$/i.test(h.trim()));
  if (trackCol >= 0) {
    const tracks = new Set(rows.slice(1).map((r) => r[trackCol] ?? ''));
    if (tracks.size > 1) {
      throw new Error(`Found ${tracks.size} tracks. Export one animal track and try again.`);
    }
  }
  return buildRecords(rows.slice(1), plan, options, 'sleap-analysis-csv', (row) => Number(row[frameCol]));
}

function planColumns(names: ReadonlyArray<string>, kinds: ReadonlyArray<string>, requireNose: boolean): ColumnPlan {
  const mapping: PoseColumnMapping[] = [];
  const parts = new Map<string, { x?: number; y?: number; conf?: number }>();

  for (let i = 0; i < names.length; i++) {
    const name = names[i] ?? '';
    const kind = kinds[i] ?? '';
    if (!name || !kind) continue;
    const entry = parts.get(name) ?? {};
    if (kind === 'x') entry.x = i;
    else if (kind === 'y') entry.y = i;
    else if (kind === 'likelihood' || kind === 'score') entry.conf = i;
    parts.set(name, entry);
  }

  const pick = (test: RegExp) => {
    for (const [name, cols] of parts) {
      if (test.test(name) && cols.x !== undefined && cols.y !== undefined) {
        return { name, x: cols.x, y: cols.y, conf: cols.conf ?? -1 };
      }
    }
    return null;
  };

  const nose = pick(NOSE_NAMES);
  const body = pick(BODY_NAMES);
  const tail = pick(TAIL_NAMES);

  for (const name of parts.keys()) {
    const usedAs = name === nose?.name ? 'nose' : name === body?.name ? 'body' : name === tail?.name ? 'tail' : 'ignored';
    mapping.push({ column: name, usedAs });
  }

  if (requireNose && (!nose || !body)) {
    throw new Error(
      `A pose file needs separate nose and body coordinates. Using one for both would invent a measurement. Found: ${[...parts.keys()].join(', ') || 'none'}.`,
    );
  }
  if (!body) {
    throw new Error(
      `No recognizable body column found in pose CSV. Found: ${[...parts.keys()].join(', ') || 'none'}.`,
    );
  }
  const missingConfidence = [nose, body, tail]
    .filter((part): part is NonNullable<typeof part> => part !== null && part.conf < 0)
    .map((part) => part.name);
  if (missingConfidence.length > 0) {
    throw new Error(
      `Missing confidence column for ${missingConfidence.join(', ')}. Assuming confidence would invent evidence. Export a scored pose CSV.`,
    );
  }

  return {
    mapping,
    nose: nose ? { x: nose.x, y: nose.y, conf: nose.conf } : null,
    body: { x: body.x, y: body.y, conf: body.conf },
    tail: tail ? { x: tail.x, y: tail.y, conf: tail.conf } : null,
  };
}

function buildRecords(
  dataRows: ReadonlyArray<ReadonlyArray<string>>,
  plan: ColumnPlan,
  options: PoseImportOptions & { readonly requireNose?: boolean },
  format: Exclude<PoseFormat, 'unknown'>,
  frameOf: (row: ReadonlyArray<string>) => number,
): ParsedPoseCsv {
  const minLikelihood = options.minLikelihood ?? 0.6;
  if (!Number.isFinite(minLikelihood) || minLikelihood < 0 || minLikelihood > 1) {
    throw new Error('The pose confidence threshold must be a number between 0 and 1.');
  }

  const read = (
    row: ReadonlyArray<string>,
    cols: { x: number; y: number; conf: number } | null,
  ): { point: Point | null; conf: number; invalidConfidence: boolean } => {
    if (!cols) return { point: null, conf: 0, invalidConfidence: false };
    const rawX = row[cols.x]?.trim() ?? '';
    const rawY = row[cols.y]?.trim() ?? '';
    const rawConfidence = row[cols.conf]?.trim() ?? '';
    const x = rawX === '' ? Number.NaN : Number(rawX);
    const y = rawY === '' ? Number.NaN : Number(rawY);
    const conf = rawConfidence === '' ? Number.NaN : Number(rawConfidence);
    if (!Number.isFinite(conf) || conf < 0 || conf > 1) {
      return { point: null, conf: 0, invalidConfidence: true };
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { point: null, conf, invalidConfidence: false };
    if (conf < minLikelihood) return { point: null, conf, invalidConfidence: false };
    return { point: { x, y }, conf, invalidConfidence: false };
  };

  const frames: PoseFrameRecord[] = [];
  const warnings: string[] = [];
  let lowConfidenceFrames = 0;
  let invalidConfidenceFrames = 0;
  let maxFrame = -1;
  const seenFrames = new Set<number>();
  const requireNose = options.requireNose ?? false;

  for (const row of dataRows) {
    if (row.length < 2) continue;
    const frame = frameOf(row);
    if (!Number.isInteger(frame) || frame < 0) {
      throw new Error(`The pose file contains an invalid frame index: ${String(frame)}.`);
    }
    if (seenFrames.has(frame)) throw new Error(`The pose file contains frame ${frame} more than once.`);
    seenFrames.add(frame);
    maxFrame = Math.max(maxFrame, frame);

    const nose = read(row, plan.nose);
    const body = read(row, plan.body);
    const tail = read(row, plan.tail);
    if (nose.invalidConfidence || body.invalidConfidence || tail.invalidConfidence) invalidConfidenceFrames++;
    const present = requireNose ? body.point !== null && nose.point !== null : body.point !== null;
    if (!present) lowConfidenceFrames++;

    frames.push({
      frame,
      body: present ? body.point : null,
      nose: requireNose ? (present ? nose.point : null) : nose.point,
      tail: tail.point,
      bodyConf: body.conf,
      noseConf: nose.conf,
      tailConf: tail.conf,
    });
  }

  if (frames.length === 0) throw new Error('This file has a readable header but no frames of data.');
  frames.sort((a, b) => a.frame - b.frame);

  if (invalidConfidenceFrames > 0) {
    warnings.push(
      `${invalidConfidenceFrames} frame(s) have missing or out-of-range confidence and are treated as gaps.`,
    );
  }
  if (!plan.nose) {
    warnings.push('No nose column found. Body-center measures are usable, but nose-based measures will be empty.');
  }
  if (!plan.tail) {
    warnings.push('No tail column found. Nose and body positions are still usable.');
  }
  if (lowConfidenceFrames > frames.length * 0.2) {
    warnings.push(
      `${lowConfidenceFrames} of ${frames.length} frames are below confidence ${minLikelihood} and are treated as gaps.`,
    );
  }

  return {
    format,
    frames,
    mapping: plan.mapping,
    frameCount: maxFrame + 1,
    lowConfidenceFrames,
    hasNose: plan.nose !== null,
    hasTail: plan.tail !== null,
    warnings,
  };
}

/**
 * Write a pose track as a DeepLabCut-style CSV. Missing coordinates are written
 * empty rather than (0, 0).
 */
export function exportDeepLabCutPoseCsv(
  points: ReadonlyArray<PoseExportPoint>,
  options: PoseExportOptions = {},
): string {
  const scorer = options.scorer ?? 'rodent-tracker';
  const parts = ['nose', 'body', 'tail'] as const;

  const lines: string[] = [];
  lines.push(['scorer', ...parts.flatMap(() => [scorer, scorer, scorer])].join(','));
  lines.push(['bodyparts', ...parts.flatMap((p) => [p, p, p])].join(','));
  lines.push(['coords', ...parts.flatMap(() => ['x', 'y', 'likelihood'])].join(','));

  for (const o of points) {
    const cells: string[] = [String(o.frame)];
    for (const part of parts) {
      const point = part === 'nose' ? o.nose : part === 'body' ? o.body : o.tail;
      if (point) {
        cells.push(point.x.toFixed(3), point.y.toFixed(3), o.confidence.toFixed(4));
      } else {
        cells.push('', '', '0');
      }
    }
    lines.push(cells.join(','));
  }

  return `${lines.join('\n')}\n`;
}

/** Minimal CSV reader: quoted fields, embedded commas, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // A trailing newline leaves an empty final row.
  return rows.filter((r) => r.length > 1 || (r[0] ?? '').trim() !== '');
}
