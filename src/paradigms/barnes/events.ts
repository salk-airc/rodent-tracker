/** Detect hole investigations and entries from resolved tracking. */

import type {
  AnalysisParams,
  EventParams,
  HoleEvent,
  MazeGeometry,
  TrackFrame,
  Timebase,
} from './types';
import { holeByIndex, holeNumber, pxPerCm } from './types';
import { frameAtTime, frameEndTime, frameSpan, frameTime } from '../../time';

export interface DetectEventsInput {
  readonly frames: ReadonlyArray<TrackFrame>;
  readonly geometry: MazeGeometry;
  readonly params: AnalysisParams;
  readonly timebase: Timebase;
  readonly bodyAreaPx: number;
  readonly trialStartFrame: number;
}

export interface EventsResult {
  readonly events: ReadonlyArray<HoleEvent>;
  /** Which hole the evidence says is the target, when the user has not said. */
  readonly targetSuggestion: TargetSuggestion | null;
  readonly warnings: ReadonlyArray<string>;
}

export interface TargetSuggestion {
  readonly holeIndex: number;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly evidence: string;
}

interface Visit {
  readonly holeIndex: number;
  startIndex: number;
  endIndex: number;
}

export function detectEvents(input: DetectEventsInput): EventsResult {
  const { frames, geometry, params, timebase, bodyAreaPx, trialStartFrame } = input;
  if (frames.length === 0 || timebase.ptsTicks.length === 0) {
    return {
      events: [],
      targetSuggestion: null,
      warnings: geometry.targetHoleIndex === null
        ? ['No frames were available. No target hole is set.']
        : ['No frames were available.'],
    };
  }

  const ev = params.events;
  const scale = pxPerCm(geometry);
  const radiusPx = ev.investigationRadiusCm * scale;
  const boundedStartFrame = Math.max(0, Math.min(trialStartFrame, timebase.ptsTicks.length - 1));
  const lastFrame = Math.min(frames[frames.length - 1]!.frame, timebase.ptsTicks.length - 1);
  const analysisEndSec = Math.min(
    frameTime(timebase, lastFrame),
    frameTime(timebase, boundedStartFrame) + params.trialCutoffSec,
  );
  const analysisEndFrame = frameAtTime(timebase, analysisEndSec);

  // --- group consecutive frames spent at the same hole ----------------------
  //
  // With hysteresis: a visit begins when the nose comes inside the
  // investigation radius and ends only when it moves out past a wider one.
  // A single threshold fragments long investigations, because an animal parked
  // at a hole holds its nose right about at the threshold.
  const exitRadiusPx = radiusPx * ev.exitRadiusMultiple;
  const visits: Visit[] = [];
  let open: Visit | null = null;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    if (f.frame < trialStartFrame) continue;
    if (f.frame > analysisEndFrame) break;

    if (open) {
      const stillThere = distanceToHole(f, geometry, open.holeIndex) <= exitRadiusPx;
      if (stillThere) {
        open.endIndex = i;
        continue;
      }
      // Left this hole. Close it, unless it reopens within the merge gap.
      const reopened = holeUnderNose(f, geometry, radiusPx);
      const gapSec = timeBetweenFrames(timebase, frames[open.endIndex]!.frame, f.frame);
      if (reopened === open.holeIndex && gapSec <= ev.mergeGapSec) {
        open.endIndex = i;
        continue;
      }
      if (gapSec <= ev.mergeGapSec) {
        // Briefly out of range but not yet at another hole: keep it open.
        if (reopened === null) continue;
      }
      visits.push(open);
      open = null;
    }

    const hole = holeUnderNose(f, geometry, radiusPx);
    if (hole === null) continue;
    const previous = visits[visits.length - 1];
    if (
      previous &&
      previous.holeIndex === hole &&
      timeBetweenFrames(timebase, frames[previous.endIndex]!.frame, f.frame) <= ev.mergeGapSec
    ) {
      open = visits.pop()!;
      open.endIndex = i;
    } else {
      open = { holeIndex: hole, startIndex: i, endIndex: i };
    }
  }
  if (open) visits.push(open);

  const events: HoleEvent[] = [];
  const warnings: string[] = [];
  const seenHoles = new Set<number>();
  let seq = 0;

  for (const v of visits) {
    const startFrame = frames[v.startIndex]!.frame;
    const endFrame = frames[v.endIndex]!.frame;
    const durationSec = frameSpan(timebase, startFrame, endFrame, analysisEndSec);
    const window = frames.slice(v.startIndex, v.endIndex + 1);
    const explicitManualEntry = window.some(
      (frame) => frame.status === 'inHole' && frame.statusProvenance === 'manual',
    );
    if (durationSec + Number.EPSILON < ev.minInvestigationSec && !explicitManualEntry) continue;

    const isTarget = geometry.targetHoleIndex === v.holeIndex;
    const hole = holeByIndex(geometry, v.holeIndex);
    if (!hole) continue;
    const minNoseDistPx = Math.min(
      ...window.map((f) => (f.nose ? Math.hypot(f.nose.x - hole.center.x, f.nose.y - hole.center.y) : Number.POSITIVE_INFINITY)),
    );
    const measuredAreaRatios = bodyAreaPx > 0
      ? window.map((f) => areaOf(f) / bodyAreaPx).filter(Number.isFinite)
      : [];
    const minAreaRatio = measuredAreaRatios.length ? Math.min(...measuredAreaRatios) : Number.NaN;
    const anyManual = explicitManualEntry || window.some((f) => f.noseProvenance === 'manual');
    const eventProvenance = anyManual
      ? 'manual' as const
      : window.some((f) => f.noseProvenance === 'imported')
        ? 'imported' as const
        : 'auto' as const;

    const firstVisit = !seenHoles.has(v.holeIndex);
    seenHoles.add(v.holeIndex);
    const counts = countsAsError(v.holeIndex, geometry, ev, firstVisit);

    events.push({
      id: `inv-${seq++}`,
      type: 'investigation',
      holeIndex: v.holeIndex,
      startFrame,
      endFrame,
      isTarget,
      isError: counts,
      minNoseDistanceCm: minNoseDistPx / scale,
      minAreaRatio,
      provenance: eventProvenance,
      evidence: explicitManualEntry
        ? `Manual inside-hole label at hole ${holeNumber(geometry, v.holeIndex)}, frame ${window.find((frame) => frame.status === 'inHole' && frame.statusProvenance === 'manual')!.frame}.`
        : `Hole ${holeNumber(geometry, v.holeIndex)}: nose distance ${(minNoseDistPx / scale).toFixed(2)} cm for ${durationSec.toFixed(2)} s, ` +
          `frames ${startFrame}-${endFrame}. Threshold: ${ev.investigationRadiusCm} cm for at least ${ev.minInvestigationSec} s.`,
    });

    // --- is this visit also an entry? -------------------------------------
    const entry = findEntryRun(window, bodyAreaPx, ev, timebase, analysisEndSec);
    if (entry) {
      const entryStart = frames[v.startIndex + entry.start]!.frame;
      const entryEnd = frames[v.startIndex + entry.end]!.frame;
      const entrySec = frameSpan(timebase, entryStart, entryEnd, analysisEndSec);
      const reachedEnd = analysisEndSec - frameEndTime(timebase, entryEnd) <= ev.mergeGapSec;
      events.push({
        id: `ent-${seq++}`,
        type: 'entry',
        holeIndex: v.holeIndex,
        startFrame: entryStart,
        endFrame: entryEnd,
        isTarget,
        isError: false, // an entry is not an extra error; the investigation already counted
        minNoseDistanceCm: minNoseDistPx / scale,
        minAreaRatio: entry.minRatio,
        provenance: eventProvenance,
        evidence:
          (entry.support === 'manual'
            ? `Manual entry at hole ${holeNumber(geometry, v.holeIndex)}, frame ${entryStart}.`
            : `Hole ${holeNumber(geometry, v.holeIndex)}: Visible area fell to ${(entry.minRatio * 100).toFixed(0)}% of normal and stayed below ` +
              `${(ev.entryAreaRatio * 100).toFixed(0)}% for ${entrySec.toFixed(2)} s, frames ${entryStart}-${entryEnd}` +
              (reachedEnd ? ', through the end of the analyzed trial.' : '.')),
      });
    }
  }

  if (geometry.targetHoleIndex === null) {
    warnings.push('No target hole set. Latencies and errors are unavailable.');
  }

  const firstTargetEntry = events
    .filter((event) => event.type === 'entry' && event.isTarget)
    .sort((a, b) => a.startFrame - b.startFrame)[0];
  const trialEvents = firstTargetEntry
    ? events.filter((event) => event.startFrame <= firstTargetEntry.startFrame)
    : events;

  return {
    events: trialEvents,
    targetSuggestion: suggestTarget(geometry, trialEvents, timebase, analysisEndSec, ev.mergeGapSec),
    warnings,
  };
}

/** Seconds not assigned to either of two observed frames. */
function timeBetweenFrames(timebase: Timebase, earlierFrame: number, laterFrame: number): number {
  return Math.max(0, frameTime(timebase, laterFrame) - frameEndTime(timebase, earlierFrame));
}

/** Measured visible area for the entry test; manual labels do not replace it. */
function areaOf(f: TrackFrame): number {
  if (!f.areaMeasured) return Number.NaN;
  return f.areaPx;
}

/** Distance from the nose to one particular hole, in px. */
function distanceToHole(f: TrackFrame, geometry: MazeGeometry, holeIndex: number): number {
  if (f.interpolated) return Number.POSITIVE_INFINITY;
  if (f.status === 'inHole' && f.holeIndex === holeIndex) return 0;
  const hole = holeByIndex(geometry, holeIndex);
  if (!hole || !f.nose) return Number.POSITIVE_INFINITY;
  return Math.hypot(f.nose.x - hole.center.x, f.nose.y - hole.center.y);
}

function holeUnderNose(f: TrackFrame, geometry: MazeGeometry, radiusPx: number): number | null {
  if (f.status === 'preTrial' || f.status === 'postTrial') return null;
  if (f.interpolated) return null;
  // A frame read as inside a hole belongs to that hole by definition, whatever
  // the imputed nose position says.
  if (f.status === 'inHole' && f.holeIndex !== null) return f.holeIndex;
  if (!f.nose) return null;
  let best = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const h of geometry.holes) {
    const d = Math.hypot(f.nose.x - h.center.x, f.nose.y - h.center.y);
    if (d < bestDist) {
      bestDist = d;
      best = h.index;
    }
  }
  return bestDist <= radiusPx ? best : null;
}

/**
 * Whether a non-target visit is counted as an error.
 *
 * Two conventions are exposed because labs differ: whether to count each hole
 * once or every visit, and whether the two holes either side of the target are
 * near-misses rather than mistakes. Both change the number, so both are
 * visible.
 */
function countsAsError(holeIndex: number, geometry: MazeGeometry, ev: EventParams, firstVisit: boolean): boolean {
  if (geometry.targetHoleIndex === null) return false;
  if (holeIndex === geometry.targetHoleIndex) return false;
  if (ev.errorCounting === 'unique' && !firstVisit) return false;
  if (!ev.adjacentHolesAreErrors) {
    const n = geometry.holeCount;
    const d = Math.abs(holeIndex - geometry.targetHoleIndex);
    if (Math.min(d, n - d) === 1) return false;
  }
  return true;
}

/**
 * Longest run within a visit where the animal is mostly out of sight.
 *
 * Returns null unless the run is long enough to be an entry rather than a
 * change of posture.
 */
function findEntryRun(
  window: ReadonlyArray<TrackFrame>,
  bodyAreaPx: number,
  ev: EventParams,
  timebase: Timebase,
  analysisEndSec: number,
): { start: number; end: number; minRatio: number; support: 'measured' | 'manual' } | null {
  // One frame is enough when a person explicitly labels the animal inside the
  // hole: that action identifies the entry frame. Automatic evidence remains
  // subject to the duration threshold below.
  const manual = window.findIndex(
    (frame) => frame.status === 'inHole' && frame.statusProvenance === 'manual',
  );
  if (manual >= 0) return { start: manual, end: manual, minRatio: Number.NaN, support: 'manual' };

  if (bodyAreaPx <= 0) return null;

  let best: {
    start: number;
    end: number;
    minRatio: number;
    durationSec: number;
    support: 'measured' | 'manual';
  } | null = null;
  let i = 0;
  while (i < window.length) {
    const first = window[i]!;
    if (!first.areaMeasured || first.status === 'inHole' || first.areaPx / bodyAreaPx >= ev.entryAreaRatio) {
      i++;
      continue;
    }
    let j = i;
    let minRatio = 1;
    while (
      j < window.length &&
      window[j]!.areaMeasured &&
      window[j]!.status !== 'inHole' &&
      window[j]!.areaPx / bodyAreaPx < ev.entryAreaRatio
    ) {
      const frame = window[j]!;
      minRatio = Math.min(minRatio, frame.areaPx / bodyAreaPx);
      j++;
    }
    const durationSec = frameSpan(timebase, window[i]!.frame, window[j - 1]!.frame, analysisEndSec);
    if (durationSec + Number.EPSILON >= ev.minEntrySec && (!best || durationSec > best.durationSec)) {
      best = { start: i, end: j - 1, minRatio, durationSec, support: 'measured' };
    }
    i = Math.max(j, i + 1);
  }
  return best
    ? { start: best.start, end: best.end, minRatio: best.minRatio, support: best.support }
    : null;
}

/** Suggest an escape hole from entry evidence. User confirmation is required. */
function suggestTarget(
  geometry: MazeGeometry,
  events: ReadonlyArray<HoleEvent>,
  timebase: Timebase,
  analysisEndSec: number,
  terminalGapSec: number,
): TargetSuggestion | null {
  const entries = events.filter((e) => e.type === 'entry');
  if (entries.length === 0) return suggestFromDwell(geometry, events, timebase, analysisEndSec, terminalGapSec);

  const scored = entries.map((e) => {
    const durationSec = frameSpan(timebase, e.startFrame, e.endFrame, analysisEndSec);
    const terminal = analysisEndSec - frameEndTime(timebase, e.endFrame) <= terminalGapSec;
    return { e, durationSec, terminal };
  });

  const terminal = scored.filter((s) => s.terminal).sort((a, b) => b.durationSec - a.durationSec);
  if (terminal.length === 1) {
    const s = terminal[0]!;
    return {
      holeIndex: s.e.holeIndex,
      confidence: 'high',
      evidence:
        `Hole ${holeNumber(geometry, s.e.holeIndex)}: entry at frame ${s.e.startFrame}, lasting ${s.durationSec.toFixed(2)} s through the analyzed interval.`,
    };
  }

  const longest = [...scored].sort((a, b) => b.durationSec - a.durationSec)[0]!;
  return {
    holeIndex: longest.e.holeIndex,
    confidence: terminal.length > 1 ? 'low' : 'medium',
    evidence:
      `Longest entry: hole ${holeNumber(geometry, longest.e.holeIndex)}, ${longest.durationSec.toFixed(2)} s from frame ${longest.e.startFrame}` +
      (terminal.length > 1
        ? `. ${terminal.length} terminal entries make this uncertain.`
        : '. The animal exited again, so confirmation is required.'),
  };
}

/** Suggest a target from terminal or longest dwell when no entry was detected. */
function suggestFromDwell(
  geometry: MazeGeometry,
  events: ReadonlyArray<HoleEvent>,
  timebase: Timebase,
  analysisEndSec: number,
  terminalGapSec: number,
): TargetSuggestion | null {
  const investigations = events.filter((e) => e.type === 'investigation');
  if (investigations.length === 0) return null;

  const secOf = (e: HoleEvent) => frameSpan(timebase, e.startFrame, e.endFrame, analysisEndSec);
  const dwell = new Map<number, number>();
  for (const e of investigations) dwell.set(e.holeIndex, (dwell.get(e.holeIndex) ?? 0) + secOf(e));
  const ranked = [...dwell.entries()].sort((a, b) => b[1] - a[1]);

  // Prefer a terminal visit over cumulative dwell. Cumulative dwell can favor
  // an earlier pause even when the recording ends with the animal at a hole.
  const last = [...investigations].sort((a, b) => b.endFrame - a.endFrame)[0]!;
  if (analysisEndSec - frameEndTime(timebase, last.endFrame) <= terminalGapSec) {
    return {
      holeIndex: last.holeIndex,
      confidence: 'medium',
      evidence:
        `No entry detected. The final ${secOf(last).toFixed(2)} s were spent at hole ${holeNumber(geometry, last.holeIndex)}. ` +
        'This is a suggestion, not a measured escape hole.',
    };
  }

  const [holeIndex, sec] = ranked[0]!;
  const runnerUp = ranked[1];
  return {
    holeIndex,
    confidence: 'low',
    evidence:
      `Low-confidence suggestion. No entry or terminal hole visit detected. Longest dwell: hole ${holeNumber(geometry, holeIndex)}, ${sec.toFixed(2)} s` +
      (runnerUp ? `, against ${runnerUp[1].toFixed(2)} s at hole ${runnerUp[0]}` : '') +
      '. Set the target from the run sheet.',
  };
}
