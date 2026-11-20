/** Resolve frame observations into statuses, positions, gaps, and provenance. */

import type {
  AnalysisParams,
  FrameStatus,
  MazeGeometry,
  MeasurementProvenance,
  Point,
  TrackFrame,
  TrackObservation,
  TrackingQuality,
  TrialStart,
} from '../types';
import { hasMeasuredPosition, holeByIndex, holeNumber, nearestHole, type Timebase } from '../types';
import { frameSpan } from '../time';
import { median } from '../stats';

export interface ResolveInput {
  readonly observations: ReadonlyArray<TrackObservation>;
  readonly timebase: Timebase;
  readonly geometry: MazeGeometry;
  readonly params: AnalysisParams;
  readonly bodyAreaPx: number;
  readonly trialStart: TrialStart;
  /** Manual corrections, keyed by frame. These always win. */
  readonly corrections?: ReadonlyMap<number, ManualCorrection>;
  readonly positionProvenance: Exclude<MeasurementProvenance, 'manual'>;
}

/** A provenance-preserving correction to one frame. */
export interface ManualCorrection {
  readonly frame: number;
  readonly status?: FrameStatus;
  /** `null` explicitly removes a stale point, while `undefined` leaves it unchanged. */
  readonly body?: Point | null;
  readonly nose?: Point | null;
  readonly holeIndex?: number | null;
  readonly note?: string;
}

export interface ResolvedTrack {
  /** Source observations registered to the geometry used for this result. */
  readonly registeredObservations: ReadonlyArray<TrackObservation>;
  readonly frames: ReadonlyArray<TrackFrame>;
  readonly quality: TrackingQuality;
  readonly trialStart: TrialStart;
  /** Absence runs and what we concluded about each, for the quality report. */
  readonly gaps: ReadonlyArray<GapReport>;
}

export interface GapReport {
  readonly startFrame: number;
  readonly endFrame: number;
  readonly frames: number;
  readonly durationSec: number;
  readonly verdict: 'inHole' | 'lost';
  readonly holeIndex: number | null;
  readonly explanation: string;
}

/** Recompute maze-relative fields whenever the user edits the outline or holes. */
export function registerObservationsToMaze(
  observations: ReadonlyArray<TrackObservation>,
  geometry: MazeGeometry,
): TrackObservation[] {
  return observations.map((observation) => {
    const point = observation.nose ?? observation.body;
    const nearest = point ? nearestHole(geometry, point) : null;
    if (!point || !nearest) {
      return {
        ...observation,
        nearestHole: -1,
        nearestHoleDistPx: Number.POSITIVE_INFINITY,
        radialFraction: Number.NaN,
      };
    }
    const body = observation.body ?? point;
    return {
      ...observation,
      nearestHole: nearest.hole.index,
      nearestHoleDistPx: nearest.distPx,
      radialFraction:
        geometry.platformRadiusPx > 0
          ? Math.hypot(body.x - geometry.center.x, body.y - geometry.center.y) / geometry.platformRadiusPx
          : Number.NaN,
    };
  });
}

export function resolveTrack(input: ResolveInput): ResolvedTrack {
  const { timebase, geometry, params, bodyAreaPx, trialStart, corrections } = input;
  const observations = registerObservationsToMaze(input.observations, geometry);
  const tracking = params.tracking;

  const statuses: FrameStatus[] = [];
  const holeIndices: (number | null)[] = [];
  const bodies: (Point | null)[] = [];
  const noses: (Point | null)[] = [];
  const confidences: number[] = [];

  // --- Stage 1: classify each frame on its own evidence ---------------------
  for (let i = 0; i < observations.length; i++) {
    const o = observations[i]!;
    if (o.frame < trialStart.frame) {
      statuses.push('preTrial');
      holeIndices.push(null);
      bodies.push(null);
      noses.push(null);
      confidences.push(1);
      continue;
    }

    const ratio = bodyAreaPx > 0 ? o.areaPx / bodyAreaPx : 0;
    const atHole = o.nearestHoleDistPx <= tracking.holeLockRadiusPx;

    if (!o.areaMeasured) {
      // Pose imports have measured nose/body coordinates but no visible-area
      // measurement. Preserve the coordinates without inventing an area.
      if (o.body && o.nose) {
        statuses.push('tracked');
        holeIndices.push(null);
        bodies.push(o.body);
        noses.push(o.nose);
        confidences.push(clamp01(o.axisConfidence));
      } else {
        statuses.push('lost');
        holeIndices.push(null);
        bodies.push(null);
        noses.push(null);
        confidences.push(0);
      }
    } else if (o.areaPx === 0) {
      statuses.push('lost'); // provisionally; gap analysis may upgrade to inHole
      holeIndices.push(null);
      bodies.push(null);
      noses.push(null);
      confidences.push(0);
    } else if (ratio > tracking.maxAreaRatio) {
      // Too big to be this animal. Something else is on the platform.
      statuses.push('lost');
      holeIndices.push(null);
      bodies.push(null);
      noses.push(null);
      confidences.push(0);
    } else if (ratio < tracking.partialAreaRatio && atHole) {
      statuses.push('partial');
      holeIndices.push(o.nearestHole);
      bodies.push(o.body);
      noses.push(o.nose);
      confidences.push(clamp01(0.4 + 0.4 * o.axisConfidence));
    } else {
      statuses.push('tracked');
      holeIndices.push(null);
      bodies.push(o.body);
      noses.push(o.nose);
      confidences.push(frameConfidence(o, ratio));
    }
  }

  // --- Stage 2: apply human evidence before explaining gaps ----------------
  const statusProvenances = new Array<MeasurementProvenance>(observations.length).fill(input.positionProvenance);
  const bodyProvenances = new Array<MeasurementProvenance>(observations.length).fill(input.positionProvenance);
  const noseProvenances = new Array<MeasurementProvenance>(observations.length).fill(input.positionProvenance);
  const manualStatuses = new Array<boolean>(observations.length).fill(false);
  const interpolated = new Array<boolean>(observations.length).fill(false);
  if (corrections?.size) {
    for (let i = 0; i < observations.length; i++) {
      // Trial boundaries are separate evidence. Keep a saved correction ready
      // in case the start is moved earlier, but do not let it turn a pre-trial
      // frame into an in-trial measurement.
      if (observations[i]!.frame < trialStart.frame) continue;
      const c = corrections.get(observations[i]!.frame);
      if (!c) continue;
      const correctedHole = c.status === 'inHole' && c.holeIndex !== null && c.holeIndex !== undefined
        ? geometry.holes.find((hole) => hole.index === c.holeIndex)
        : undefined;
      const canApplyStatus = c.status !== 'inHole' || correctedHole !== undefined;
      if (c.status !== undefined && canApplyStatus) {
        statuses[i] = c.status;
      }
      if (c.body !== undefined) {
        bodies[i] = c.body;
      }
      if (c.nose !== undefined) {
        noses[i] = c.nose;
      }
      if (correctedHole) holeIndices[i] = correctedHole.index;
      interpolated[i] = false;

      // A status and its coordinates are one claim. Normalize project files and
      // UI actions here so stale automatic points cannot leak through a manual
      // "lost" correction, and a positionless frame cannot call itself tracked.
      const status = statuses[i]!;
      if (status === 'lost' || status === 'preTrial' || status === 'postTrial') {
        bodies[i] = null;
        noses[i] = null;
        holeIndices[i] = null;
        confidences[i] = status === 'lost' ? 0 : 1;
      } else if (status === 'inHole') {
        const holeIndex = holeIndices[i] ?? null;
        const hole = holeIndex === null ? undefined : geometry.holes.find((candidate) => candidate.index === holeIndex);
        if (hole) {
          bodies[i] = hole.center;
          noses[i] = hole.center;
          if (statusProvenances[i] === 'manual') {
            bodyProvenances[i] = 'manual';
            noseProvenances[i] = 'manual';
          }
          confidences[i] = 1;
        } else {
          statuses[i] = 'lost';
          bodies[i] = null;
          noses[i] = null;
          holeIndices[i] = null;
          confidences[i] = 0;
        }
      } else {
        // A missing nose stays missing. Copying the body coordinate into it
        // could create an unsupported hole visit.
        if (!bodies[i]) {
          statuses[i] = 'lost';
          bodies[i] = null;
          noses[i] = null;
          holeIndices[i] = null;
          confidences[i] = 0;
        } else {
          confidences[i] = 1;
        }
      }

      // Attribute only corrections that survived normalization. An invalid or
      // incomplete correction must not turn later automatic gap inference into
      // a human-labeled event.
      const statusIsManual = c.status !== undefined && canApplyStatus && statuses[i] === c.status;
      if (statusIsManual) {
        statusProvenances[i] = 'manual';
        manualStatuses[i] = true;
      }
      if (
        (c.body !== undefined && samePoint(bodies[i], c.body)) ||
        (statusIsManual && c.status === 'inHole')
      ) bodyProvenances[i] = 'manual';
      if (
        (c.nose !== undefined && samePoint(noses[i], c.nose)) ||
        (statusIsManual && c.status === 'inHole')
      ) noseProvenances[i] = 'manual';
    }
  }

  // --- Stage 3: explain and optionally bridge the remaining absences -------
  const gaps = explainGaps(
    observations,
    statuses,
    holeIndices,
    bodies,
    noses,
    manualStatuses,
    timebase,
    geometry,
    tracking,
  );
  if (params.maxInterpolateGapFrames > 0) {
    fillShortGaps(statuses, bodies, noses, interpolated, params.maxInterpolateGapFrames);
  }

  // --- Stage 4: smooth automatic measurements, never human corrections -----
  if (params.smoothingWindowFrames > 1) {
    medianSmooth(bodies, statuses, interpolated, bodyProvenances, params.smoothingWindowFrames);
    medianSmooth(noses, statuses, interpolated, noseProvenances, params.smoothingWindowFrames);
  }

  const frames: TrackFrame[] = observations.map((o, i) => ({
    frame: o.frame,
    status: statuses[i]!,
    body: bodies[i] ?? null,
    nose: noses[i] ?? null,
    areaPx: o.areaPx,
    areaMeasured: o.areaMeasured,
    holeIndex: holeIndices[i] ?? null,
    confidence: confidences[i]!,
    interpolated: interpolated[i]!,
    statusProvenance: statusProvenances[i]!,
    bodyProvenance: bodyProvenances[i]!,
    noseProvenance: noseProvenances[i]!,
    provenance:
      statusProvenances[i] === 'manual' || bodyProvenances[i] === 'manual' || noseProvenances[i] === 'manual'
        ? 'manual'
        : input.positionProvenance,
  }));

  return {
    registeredObservations: observations,
    frames,
    quality: summarize(frames, bodyAreaPx, gaps),
    trialStart,
    gaps,
  };
}

function samePoint(a: Point | null | undefined, b: Point | null | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a === null || b === null ? a === b : a.x === b.x && a.y === b.y;
}

// ---------------------------------------------------------------------------

function frameConfidence(o: TrackObservation, ratio: number): number {
  let c = 1;
  // Size unlike the animal we have been following.
  c -= Math.min(0.5, Math.abs(Math.log(Math.max(ratio, 0.05))) * 0.4);
  if (o.candidateCount > 1) c -= 0.1;
  if (o.reacquired) c -= 0.25;
  c -= (1 - o.axisConfidence) * 0.2;
  return clamp01(c);
}

/** Classify each absence as inside a hole or lost from tracking. */
function explainGaps(
  observations: ReadonlyArray<TrackObservation>,
  statuses: FrameStatus[],
  holeIndices: (number | null)[],
  bodies: (Point | null)[],
  noses: (Point | null)[],
  manualStatuses: ReadonlyArray<boolean>,
  timebase: Timebase,
  geometry: MazeGeometry,
  tracking: { holeLockRadiusPx: number },
): GapReport[] {
  const gaps: GapReport[] = [];
  for (const [i, j] of lostRuns(statuses)) {

    const beforeIndex = lastPositionedIndex(statuses, bodies, i - 1);
    const afterIndex = firstPositionedIndex(statuses, bodies, j);
    const beforePoint = beforeIndex === null ? null : (noses[beforeIndex] ?? bodies[beforeIndex]);
    const afterPoint = afterIndex === null ? null : (noses[afterIndex] ?? bodies[afterIndex]);
    const before = beforePoint
      ? nearestHoleEvidence(beforePoint, holeIndices[beforeIndex!] ?? null, geometry)
      : null;
    const startFrame = observations[i]!.frame;
    const endFrame = observations[j - 1]!.frame;
    const durationSec = frameSpan(timebase, startFrame, endFrame);

    let verdict: 'inHole' | 'lost' = 'lost';
    let holeIndex: number | null = null;
    let explanation: string;

    if (manualStatuses.slice(i, j).some(Boolean)) {
      explanation =
        `Frames ${startFrame}-${endFrame} (${durationSec.toFixed(2)} s): a human marked this gap lost; left missing.`;
    } else if (!before) {
      explanation = `Frames ${startFrame}-${endFrame}: no prior animal position; left missing.`;
    } else if (before.nearestHoleDistPx <= tracking.holeLockRadiusPx) {
      holeIndex = before.nearestHole;
      const hole = holeByIndex(geometry, holeIndex);
      if (!afterPoint) {
        // Ending near a hole is not enough on its own. A decoder or tracker can
        // fail on the final frame just as easily as anywhere else. Only carry an
        // `inHole` state into a terminal gap when the last measured frame had
        // already become a partial animal at that hole; otherwise surface the
        // ambiguity for review.
        if (i > 0 && statuses[i - 1] === 'partial') {
          verdict = 'inHole';
          explanation =
            `Frames ${startFrame}-${endFrame} (${durationSec.toFixed(2)} s): partial at hole ${holeNumber(geometry, holeIndex)}, then absent to the end. Classified inside the hole.`;
        } else {
          explanation =
            `Frames ${startFrame}-${endFrame} (${durationSec.toFixed(2)} s): disappeared near hole ${holeNumber(geometry, holeIndex)} at the end. Entry is uncertain; review required.`;
        }
      } else {
        const reappearDist = hole
          ? Math.hypot(afterPoint.x - hole.center.x, afterPoint.y - hole.center.y)
          : Number.POSITIVE_INFINITY;
        if (reappearDist <= tracking.holeLockRadiusPx * 2.5) {
          verdict = 'inHole';
          explanation =
            `Frames ${startFrame}-${endFrame} (${durationSec.toFixed(2)} s): disappeared at hole ${holeNumber(geometry, holeIndex)} and reappeared ${reappearDist.toFixed(1)} px away. Classified inside the hole.`;
        } else {
          explanation =
            `Frames ${startFrame}-${endFrame} (${durationSec.toFixed(2)} s): disappeared at hole ${holeNumber(geometry, holeIndex)} and reappeared ${reappearDist.toFixed(1)} px away. Classified lost; review these frames.`;
        }
      }
    } else {
      explanation =
        `Frames ${startFrame}-${endFrame} (${durationSec.toFixed(2)} s): last seen ${before.nearestHoleDistPx.toFixed(0)} px from a hole. Classified lost; review these frames.`;
    }

    if (verdict === 'inHole' && holeIndex !== null) {
      const hole = holeByIndex(geometry, holeIndex);
      for (let k = i; k < j; k++) {
        statuses[k] = 'inHole';
        holeIndices[k] = holeIndex;
        // Use the hole center only as a status marker. `inHole` positions are
        // explicitly excluded from trajectory measures because no position was
        // measured during the gap.
        if (hole) {
          bodies[k] = hole.center;
          noses[k] = hole.center;
        }
      }
    }

    gaps.push({ startFrame, endFrame, frames: j - i, durationSec, verdict, holeIndex, explanation });
  }
  return gaps;
}

function lastPositionedIndex(
  statuses: ReadonlyArray<FrameStatus>,
  bodies: ReadonlyArray<Point | null>,
  from: number,
): number | null {
  for (let i = from; i >= 0; i--) {
    if ((statuses[i] === 'tracked' || statuses[i] === 'partial') && bodies[i]) return i;
  }
  return null;
}

function firstPositionedIndex(
  statuses: ReadonlyArray<FrameStatus>,
  bodies: ReadonlyArray<Point | null>,
  from: number,
): number | null {
  for (let i = from; i < statuses.length; i++) {
    if ((statuses[i] === 'tracked' || statuses[i] === 'partial') && bodies[i]) return i;
  }
  return null;
}

function nearestHoleEvidence(
  point: Point,
  explicitHoleIndex: number | null,
  geometry: MazeGeometry,
): { nearestHole: number; nearestHoleDistPx: number } | null {
  const explicit = explicitHoleIndex === null
    ? null
    : geometry.holes.find((hole) => hole.index === explicitHoleIndex) ?? null;
  if (explicit) {
    return {
      nearestHole: explicit.index,
      nearestHoleDistPx: Math.hypot(point.x - explicit.center.x, point.y - explicit.center.y),
    };
  }
  const nearest = nearestHole(geometry, point);
  return nearest ? { nearestHole: nearest.hole.index, nearestHoleDistPx: nearest.distPx } : null;
}

/**
 * Each run of consecutive lost frames, as [start, end) indices. Lazy, so a caller
 * may relabel the frames of the current run before the next run is found.
 */
function* lostRuns(statuses: ReadonlyArray<FrameStatus>): Generator<[number, number]> {
  let i = 0;
  while (i < statuses.length) {
    if (statuses[i] !== 'lost') {
      i++;
      continue;
    }
    let j = i;
    while (j < statuses.length && statuses[j] === 'lost') j++;
    yield [i, j];
    i = j;
  }
}

/** Interpolate only short unexplained gaps and label the filled frames. */
function fillShortGaps(
  statuses: ReadonlyArray<FrameStatus>,
  bodies: (Point | null)[],
  noses: (Point | null)[],
  interpolated: boolean[],
  maxGapFrames: number,
): void {
  for (const [i, j] of lostRuns(statuses)) {
    const span = j - i;
    const before = i - 1;
    const after = j;
    if (
      span <= maxGapFrames &&
      before >= 0 &&
      after < statuses.length &&
      bodies[before] &&
      bodies[after] &&
      noses[before] &&
      noses[after]
    ) {
      for (let k = i; k < j; k++) {
        const t = (k - before) / (after - before);
        bodies[k] = lerp(bodies[before]!, bodies[after]!, t);
        noses[k] = lerp(noses[before]!, noses[after]!, t);
        interpolated[k] = true;
      }
    }
  }
}

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * Median filter over positions, skipping frames with nothing in them.
 *
 * A median rather than a mean: it removes a single-frame jump without rounding
 * off the corners of a real turn, which matters because path length and turn
 * rate both feed the strategy classification.
 */
function medianSmooth(
  points: (Point | null)[],
  statuses: ReadonlyArray<FrameStatus>,
  interpolated: ReadonlyArray<boolean>,
  provenances: ReadonlyArray<MeasurementProvenance>,
  window: number,
): void {
  const half = Math.floor(window / 2);
  const original = points.slice();
  for (let i = 0; i < points.length; i++) {
    if (
      (statuses[i] !== 'tracked' && statuses[i] !== 'partial') ||
      interpolated[i] ||
      provenances[i] === 'manual' ||
      !original[i]
    ) continue;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let k = i - half; k <= i + half; k++) {
      const p = k >= 0 && k < original.length ? original[k] : null;
      if (p && (statuses[k] === 'tracked' || statuses[k] === 'partial') && !interpolated[k]) {
        xs.push(p.x);
        ys.push(p.y);
      }
    }
    if (xs.length >= 3) points[i] = { x: median(xs), y: median(ys) };
  }
}


function summarize(
  frames: ReadonlyArray<TrackFrame>,
  bodyAreaPx: number,
  gaps: ReadonlyArray<GapReport>,
): TrackingQuality {
  let tracked = 0;
  let partial = 0;
  let inHole = 0;
  let lost = 0;
  let preTrial = 0;
  let postTrial = 0;
  let edited = 0;
  for (const f of frames) {
    if (f.provenance === 'manual') edited++;
    switch (f.status) {
      case 'tracked': tracked++; break;
      case 'partial': partial++; break;
      case 'inHole': inHole++; break;
      case 'lost': lost++; break;
      case 'preTrial': preTrial++; break;
      case 'postTrial': postTrial++; break;
    }
  }
  const inTrial = frames.length - preTrial - postTrial;
  const measuredPositionFrames = frames.filter(
    (frame) => frame.status !== 'preTrial' && frame.status !== 'postTrial' && hasMeasuredPosition(frame),
  ).length;
  const measuredPositionFraction = inTrial > 0 ? measuredPositionFrames / inTrial : 0;

  let longestGapFrames = 0;
  let longestGapStart: number | null = null;
  for (const g of gaps) {
    if (g.verdict === 'lost' && g.frames > longestGapFrames) {
      longestGapFrames = g.frames;
      longestGapStart = g.startFrame;
    }
  }

  const warnings: string[] = [];
  const trackedFraction = inTrial > 0 ? (tracked + partial + inHole) / inTrial : 0;
  if (measuredPositionFraction < 0.9) {
    warnings.push(
      `Measured-position coverage is ${(measuredPositionFraction * 100).toFixed(0)}%. Review tracking gaps before export.`,
    );
  }
  if (longestGapFrames > 0 && longestGapStart !== null) {
    warnings.push(
      `Longest unexplained gap: ${longestGapFrames} frames from frame ${longestGapStart}.`,
    );
  }

  return {
    frameCount: frames.length,
    trackedFrames: tracked,
    partialFrames: partial,
    inHoleFrames: inHole,
    lostFrames: lost,
    preTrialFrames: preTrial,
    postTrialFrames: postTrial,
    manuallyEditedFrames: edited,
    measuredPositionFrames,
    measuredPositionFraction,
    trackedFraction,
    bodyAreaPx,
    longestGapFrames,
    longestGapStart,
    warnings,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
