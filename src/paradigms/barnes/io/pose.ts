/** Import and export DeepLabCut and SLEAP analysis CSV tracks. */

import type { Point, TrackFrame, TrackObservation } from '../types';

export type PoseFormat = 'deeplabcut' | 'sleap-analysis-csv' | 'unknown';

export interface PoseImportResult {
  readonly format: Exclude<PoseFormat, 'unknown'>;
  readonly observations: ReadonlyArray<TrackObservation>;
  /** Body-part names found in the file, and what each was taken to mean. */
  readonly mapping: ReadonlyArray<{ readonly column: string; readonly usedAs: 'nose' | 'body' | 'tail' | 'ignored' }>;
  readonly frameCount: number;
  /** Frames whose confidence fell below the threshold and are treated as absent. */
  readonly lowConfidenceFrames: number;
  readonly warnings: ReadonlyArray<string>;
}

export interface PoseImportOptions {
  /** Below this, a point is treated as not detected. This importer defaults to 0.6. */
  readonly minLikelihood?: number;
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

export function importPoseTrack(text: string, options: PoseImportOptions = {}): PoseImportResult {
  const format = sniffPoseFormat(text);
  switch (format) {
    case 'deeplabcut':
      return importDeepLabCut(text, options);
    case 'sleap-analysis-csv':
      return importSleapCsv(text, options);
    default:
      throw new Error(
        'Unsupported pose CSV. Use a DeepLabCut CSV or SLEAP analysis CSV. SLEAP .slp files are not supported; export CSV first.',
      );
  }
}

// ---------------------------------------------------------------------------

interface ColumnPlan {
  readonly mapping: PoseImportResult['mapping'];
  readonly nose: { x: number; y: number; conf: number } | null;
  readonly body: { x: number; y: number; conf: number } | null;
  readonly tail: { x: number; y: number; conf: number } | null;
}

/**
 * DeepLabCut's CSV: three header rows (scorer, bodyparts, coords), optionally a
 * fourth for multi-animal projects, then one row per frame whose first cell is
 * the frame index.
 */
function importDeepLabCut(text: string, options: PoseImportOptions): PoseImportResult {
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
  const plan = planColumns(names, kinds);
  const warnings: string[] = [];
  return buildObservations(rows.slice(firstData), plan, options, warnings, 'deeplabcut', (row) => Number(row[0]));
}

/**
 * SLEAP's analysis CSV: one header row, a `frame_idx` column, and `<node>.x`,
 * `<node>.y`, `<node>.score` triples.
 */
function importSleapCsv(text: string, options: PoseImportOptions): PoseImportResult {
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

  const plan = planColumns(names, kinds);
  const warnings: string[] = [];
  const tracks = new Set(rows.slice(1).map((r) => r[header.findIndex((h) => /^track$/i.test(h.trim()))] ?? ''));
  if (tracks.size > 1) {
    throw new Error(
      `Found ${tracks.size} tracks. Export one animal track and try again.`,
    );
  }
  return buildObservations(rows.slice(1), plan, options, warnings, 'sleap-analysis-csv', (row) => Number(row[frameCol]));
}

function planColumns(names: ReadonlyArray<string>, kinds: ReadonlyArray<string>): ColumnPlan {
  const mapping: { column: string; usedAs: 'nose' | 'body' | 'tail' | 'ignored' }[] = [];
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

  if (!nose || !body) {
    throw new Error(
      `A pose file needs separate nose and body coordinates. Using one for both would invent a measurement. Found: ${[...parts.keys()].join(', ') || 'none'}.`,
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
    body: body ? { x: body.x, y: body.y, conf: body.conf } : null,
    tail: tail ? { x: tail.x, y: tail.y, conf: tail.conf } : null,
  };
}

function buildObservations(
  dataRows: ReadonlyArray<ReadonlyArray<string>>,
  plan: ColumnPlan,
  options: PoseImportOptions,
  warnings: string[],
  format: Exclude<PoseFormat, 'unknown'>,
  frameOf: (row: ReadonlyArray<string>) => number,
): PoseImportResult {
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

  const observations: TrackObservation[] = [];
  let lowConfidenceFrames = 0;
  let invalidConfidenceFrames = 0;
  let maxFrame = -1;
  const seenFrames = new Set<number>();

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
    const bodyPoint = body.point;
    const nosePoint = nose.point;
    const present = bodyPoint !== null && nosePoint !== null;
    if (!present) lowConfidenceFrames++;

    observations.push({
      frame,
      // A pose file has no area. Keep that absence explicit; the resolver uses
      // coordinate presence rather than a made-up neutral area value.
      areaMeasured: false,
      areaPx: 0,
      darkPixelsPx: 0,
      body: present ? bodyPoint : null,
      nose: present ? nosePoint : null,
      tail: tail.point,
      thicknessPx: 0,
      noseArmPx: present ? Math.hypot(nosePoint.x - bodyPoint.x, nosePoint.y - bodyPoint.y) : 0,
      tailArmPx: tail.point && bodyPoint ? Math.hypot(tail.point.x - bodyPoint.x, tail.point.y - bodyPoint.y) : 0,
      nearestHole: -1,
      nearestHoleDistPx: Number.POSITIVE_INFINITY,
      radialFraction: Number.NaN,
      candidateCount: present ? 1 : 0,
      reacquired: false,
      // A pose file states which end is which, so the axis is not in doubt.
      // Scaled by what the pose tool itself reported, so a shaky detection does
      // not arrive here looking certain.
      axisConfidence:
        tail.point && nose.point ? Math.min(nose.conf, tail.conf) : present ? 0.5 * Math.min(nose.conf, body.conf) : 0,
    });
  }

  if (observations.length === 0) throw new Error('This file has a readable header but no frames of data.');

  observations.sort((a, b) => a.frame - b.frame);

  warnings.push(
    'Pose CSV has no visible area measurement. Entry latency remains censored unless an entry is marked from video.',
  );
  if (invalidConfidenceFrames > 0) {
    warnings.push(
      `${invalidConfidenceFrames} frame(s) have missing or out-of-range confidence and are treated as gaps.`,
    );
  }
  if (!plan.tail) {
    warnings.push('No tail column found. Nose and body positions are still usable.');
  }
  if (lowConfidenceFrames > observations.length * 0.2) {
    warnings.push(
      `${lowConfidenceFrames} of ${observations.length} frames are below confidence ${minLikelihood} and are treated as gaps.`,
    );
  }

  return {
    format,
    observations,
    mapping: plan.mapping,
    frameCount: maxFrame + 1,
    lowConfidenceFrames,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface PoseExportOptions {
  readonly scorer?: string;
}

/** Apply reviewed point corrections without exporting inferred positions as measurements. */
export function reviewedPoseObservations(
  observations: ReadonlyArray<TrackObservation>,
  frames: ReadonlyArray<TrackFrame>,
): TrackObservation[] {
  const reviewed = new Map(frames.map((frame) => [frame.frame, frame]));
  return observations.map((observation) => {
    const frame = reviewed.get(observation.frame);
    const usable = frame && !frame.interpolated && (frame.status === 'tracked' || frame.status === 'partial');
    return {
      ...observation,
      body: usable ? frame.body : null,
      nose: usable ? frame.nose : null,
      tail: usable ? observation.tail : null,
    };
  });
}

/**
 * Write a track as a DeepLabCut-style CSV.
 *
 * The confidence column carries our own per-frame confidence, and frames with no
 * position are written empty rather than as a coordinate of zero, which
 * DeepLabCut also does and which stops a missing frame being read as the animal
 * visiting the top-left corner.
 */
export function exportDeepLabCutCsv(
  observations: ReadonlyArray<TrackObservation>,
  confidenceOf: (o: TrackObservation) => number,
  options: PoseExportOptions = {},
): string {
  const scorer = options.scorer ?? 'barnes-maze-analyzer';
  const parts = ['nose', 'body', 'tail'] as const;

  const lines: string[] = [];
  lines.push(['scorer', ...parts.flatMap(() => [scorer, scorer, scorer])].join(','));
  lines.push(['bodyparts', ...parts.flatMap((p) => [p, p, p])].join(','));
  lines.push(['coords', ...parts.flatMap(() => ['x', 'y', 'likelihood'])].join(','));

  for (const o of observations) {
    const cells: string[] = [String(o.frame)];
    const confidence = confidenceOf(o);
    for (const part of parts) {
      const point = part === 'nose' ? o.nose : part === 'body' ? o.body : o.tail;
      if (point) {
        cells.push(point.x.toFixed(3), point.y.toFixed(3), confidence.toFixed(4));
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
