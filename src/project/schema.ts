/**
 * The project file: a documented, reloadable record of a whole session.
 *
 * Two requirements shape this. The facility needs to re-run analysis without
 * re-tracking, because in six months someone will ask why two cohorts disagree
 * and the answer will be a threshold. And whatever a number came from has to be
 * recoverable, which means the parameters and the tool version travel with the
 * data rather than living in someone's memory.
 *
 * The format is plain JSON so it can be read by anything, including a person
 * with a text editor. Per-frame arrays are stored column-wise and rounded,
 * which keeps a 5,539-frame recording to a few hundred kilobytes rather than
 * several megabytes of repeated object keys.
 */

import type {
  AnalysisParams,
  MazeGeometry,
  MeasurementBasis,
  TrackObservation,
  TrackingSource,
  TrialStart,
} from '../types';
import type { RigTemplate } from '../geometry/detect';
import type { ManualCorrection } from '../tracking/resolve';
import type { ProtocolPreset } from './protocol';
/**
 * Where a host app can read the recording again (a cloud file, a URL…).
 * Opaque to the engine: the app that wrote it is the one that reads it.
 */
export type SourceRef = Readonly<Record<string, unknown>>;

/** The only project schema this build reads and writes. */
export const PROJECT_FORMAT_VERSION = 3;

/** Set at build time; recorded in every file and every export. */
export const TOOL_VERSION = '0.2.0';

export interface ProjectFile {
  readonly format: 'barnes-maze-analyzer';
  readonly formatVersion: typeof PROJECT_FORMAT_VERSION;
  readonly toolVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly project: ProjectMeta;
  readonly params: AnalysisParams;
  readonly rigs: ReadonlyArray<RigTemplate>;
  readonly videos: ReadonlyArray<StoredVideo>;
  /** Recordings retained in the project even though no reusable track exists yet. */
  readonly excludedVideos: ReadonlyArray<ExcludedVideo>;
}

export interface ProjectMeta {
  readonly name: string;
  readonly protocol?: ProtocolPreset | null;
}

export interface ExcludedVideo {
  readonly id: string;
  readonly fileName: string;
  readonly fileSize: number | null;
  /** Where to read the recording again, set by the host app. Absent for local files. */
  readonly source?: SourceRef | null;
  readonly status: 'queued' | 'failed';
  readonly error: string | null;
}

/**
 * Per-video metadata a scientist needs and the video file cannot supply.
 *
 * Learning curves need to know which animal and which day a recording belongs
 * to, and cohort comparisons need the group. Filenames usually encode it, so
 * the interface offers to parse them, but the parsed values live here as plain
 * editable fields rather than being re-derived on every load.
 */
export interface VideoMeta {
  readonly animalId: string;
  readonly group: string;
  readonly day: number | null;
  readonly trial: number | null;
  readonly notes: string;
  /** Which of these fields came from parsing the filename rather than a person. */
  readonly parsedFromFilename: ReadonlyArray<keyof VideoMeta>;
}

export interface StoredVideo {
  /** SHA-256 of the original video bytes. Absent in older project files. */
  readonly sourceSha256?: string | null;
  readonly id: string;
  /** File name as the user knows it. Not a path: paths do not survive a reload. */
  readonly fileName: string;
  readonly fileSize: number | null;
  /** Where to read the recording again, set by the host app. Absent for local files. */
  readonly source?: SourceRef | null;
  /** Set when the analysis ran, so a re-tracked video can be spotted. */
  readonly analyzedAt: string | null;
  /** Tool version that performed the pixel pass; null for an external pose source. */
  readonly observationToolVersion: string | null;
  readonly meta: VideoMeta;
  readonly width: number;
  readonly height: number;
  readonly timebase: { readonly timescale: number; readonly ptsTicks: ReadonlyArray<number> };
  readonly geometry: MazeGeometry;
  readonly trackingSource: TrackingSource;
  /** Exact pixel-pass basis, kept separate from editable downstream settings. */
  readonly measurementBasis: MeasurementBasis;
  readonly mazeConfirmed: boolean;
  readonly rigId: string | null;
  readonly bodyAreaPx: number;
  readonly bodyAreaSpread: number;
  readonly detectedTrialStart: TrialStart;
  /** Null unless the user moved the marker. */
  readonly trialStartOverride: TrialStart | null;
  readonly observations: PackedObservations;
  readonly corrections: ReadonlyArray<ManualCorrection>;
  /** Set when the user has fixed the strategy label by hand. */
  readonly strategyOverride: { readonly strategy: string; readonly reason: string } | null;
  readonly notes: ReadonlyArray<string>;
}

/**
 * Observations stored column-wise.
 *
 * One array per field rather than one object per frame. The same data as an
 * array of 5,539 objects is roughly ten times larger, almost all of it repeated
 * key names, and it is slower to parse. Positions are rounded to a tenth of a
 * pixel, which is well inside the accuracy of the measurement and halves the
 * size again.
 */
export interface PackedObservations {
  readonly count: number;
  readonly frame: ReadonlyArray<number>;
  readonly areaMeasured: ReadonlyArray<number>;
  readonly areaPx: ReadonlyArray<number>;
  readonly darkPixelsPx: ReadonlyArray<number>;
  /** A reserved large negative integer stands for "no position." */
  readonly bodyX: ReadonlyArray<number>;
  readonly bodyY: ReadonlyArray<number>;
  readonly noseX: ReadonlyArray<number>;
  readonly noseY: ReadonlyArray<number>;
  readonly tailX: ReadonlyArray<number>;
  readonly tailY: ReadonlyArray<number>;
  readonly thicknessPx: ReadonlyArray<number>;
  readonly noseArmPx: ReadonlyArray<number>;
  readonly tailArmPx: ReadonlyArray<number>;
  readonly nearestHole: ReadonlyArray<number>;
  readonly nearestHoleDistPx: ReadonlyArray<number>;
  readonly radialFraction: ReadonlyArray<number>;
  readonly candidateCount: ReadonlyArray<number>;
  /** Packed as 0 or 1 rather than as booleans, which JSON writes far longer. */
  readonly reacquired: ReadonlyArray<number>;
  readonly axisConfidence: ReadonlyArray<number>;
}

const NO_VALUE = -2147483648;
const round1 = (v: number) => Math.round(v * 10) / 10;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

export function packObservations(observations: ReadonlyArray<TrackObservation>): PackedObservations {
  const n = observations.length;
  const cols = {
    count: n,
    frame: [] as number[],
    areaMeasured: [] as number[],
    areaPx: [] as number[],
    darkPixelsPx: [] as number[],
    bodyX: [] as number[],
    bodyY: [] as number[],
    noseX: [] as number[],
    noseY: [] as number[],
    tailX: [] as number[],
    tailY: [] as number[],
    thicknessPx: [] as number[],
    noseArmPx: [] as number[],
    tailArmPx: [] as number[],
    nearestHole: [] as number[],
    nearestHoleDistPx: [] as number[],
    radialFraction: [] as number[],
    candidateCount: [] as number[],
    reacquired: [] as number[],
    axisConfidence: [] as number[],
  };
  for (const o of observations) {
    cols.frame.push(o.frame);
    cols.areaMeasured.push(o.areaMeasured ? 1 : 0);
    cols.areaPx.push(o.areaPx);
    cols.darkPixelsPx.push(o.darkPixelsPx);
    cols.bodyX.push(o.body ? round1(o.body.x) : NO_VALUE);
    cols.bodyY.push(o.body ? round1(o.body.y) : NO_VALUE);
    cols.noseX.push(o.nose ? round1(o.nose.x) : NO_VALUE);
    cols.noseY.push(o.nose ? round1(o.nose.y) : NO_VALUE);
    cols.tailX.push(o.tail ? round1(o.tail.x) : NO_VALUE);
    cols.tailY.push(o.tail ? round1(o.tail.y) : NO_VALUE);
    cols.thicknessPx.push(round1(o.thicknessPx));
    cols.noseArmPx.push(round1(o.noseArmPx));
    cols.tailArmPx.push(round1(o.tailArmPx));
    cols.nearestHole.push(o.nearestHole);
    cols.nearestHoleDistPx.push(Number.isFinite(o.nearestHoleDistPx) ? round1(o.nearestHoleDistPx) : NO_VALUE);
    cols.radialFraction.push(Number.isFinite(o.radialFraction) ? round3(o.radialFraction) : NO_VALUE);
    cols.candidateCount.push(o.candidateCount);
    cols.reacquired.push(o.reacquired ? 1 : 0);
    cols.axisConfidence.push(round3(o.axisConfidence));
  }
  return cols;
}

export function unpackObservations(p: PackedObservations): TrackObservation[] {
  const out: TrackObservation[] = [];
  const pt = (x: number, y: number) => x === NO_VALUE || y === NO_VALUE ? null : { x, y };
  for (let i = 0; i < p.count; i++) {
    const dist = p.nearestHoleDistPx[i]!;
    const radial = p.radialFraction[i]!;
    out.push({
      frame: p.frame[i]!,
      areaMeasured: p.areaMeasured[i] === 1,
      areaPx: p.areaPx[i]!,
      darkPixelsPx: p.darkPixelsPx[i]!,
      body: pt(p.bodyX[i]!, p.bodyY[i]!),
      nose: pt(p.noseX[i]!, p.noseY[i]!),
      tail: pt(p.tailX[i]!, p.tailY[i]!),
      thicknessPx: p.thicknessPx[i]!,
      noseArmPx: p.noseArmPx[i]!,
      tailArmPx: p.tailArmPx[i]!,
      nearestHole: p.nearestHole[i]!,
      nearestHoleDistPx: dist === NO_VALUE ? Number.POSITIVE_INFINITY : dist,
      radialFraction: radial === NO_VALUE ? Number.NaN : radial,
      candidateCount: p.candidateCount[i]!,
      reacquired: p.reacquired[i] === 1,
      axisConfidence: p.axisConfidence[i]!,
    });
  }
  return out;
}
