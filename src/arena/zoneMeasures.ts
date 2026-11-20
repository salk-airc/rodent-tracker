/**
 * Per-zone measures from a track in world cm: the numbers AnyMaze-style
 * reports lead with (time in zone, entries, latency to first entry, distance).
 *
 * Conventions, stated because tools differ on them:
 * - Each interval between consecutive samples is credited to the zone of its
 *   earlier sample. A gap longer than `maxGapS`, or a sample with no position,
 *   credits nothing: missing data is reported as untracked, never guessed.
 * - Starting inside a zone counts as an entry at latency 0.
 * - An entry needs `minEntryS` of continuous presence, so a nose flickering
 *   across a line is not counted as ten entries. The entry's time is when the
 *   presence began.
 */

import type { Point } from '../types';
import { contains } from './shapes';
import type { Zone } from './arena';

export interface WorldSample {
  readonly timeS: number;
  /** Position in world cm, or null when the animal was not tracked. */
  readonly point: Point | null;
}

export interface ZoneMeasureOptions {
  /** Longer gaps between samples are not credited to any zone. Default 0.5 s. */
  readonly maxGapS?: number;
  /** Presence needed before an entry counts. Default 0 (any presence). */
  readonly minEntryS?: number;
}

export interface ZoneMeasures {
  readonly zoneId: string;
  readonly timeS: number;
  readonly entries: number;
  /** Time from the first sample to the first entry; null when never entered. */
  readonly latencyS: number | null;
  /** Path length travelled while in the zone. */
  readonly distanceCm: number;
}

export interface TrackSummary {
  readonly durationS: number;
  readonly trackedS: number;
  readonly distanceCm: number;
  readonly zones: ReadonlyArray<ZoneMeasures>;
}

export function measureZones(
  samples: ReadonlyArray<WorldSample>,
  zones: ReadonlyArray<Zone>,
  options: ZoneMeasureOptions = {},
): TrackSummary {
  const maxGapS = options.maxGapS ?? 0.5;
  const minEntryS = options.minEntryS ?? 0;
  const t0 = samples[0]?.timeS ?? 0;
  const durationS = samples.length ? samples[samples.length - 1]!.timeS - t0 : 0;
  let trackedS = 0;
  let distanceCm = 0;

  const out = zones.map((zone) => {
    let timeS = 0;
    let dist = 0;
    let entries = 0;
    let latencyS: number | null = null;
    // Start of the current unbroken presence, and whether it has been counted.
    let presenceStart: number | null = null;
    let counted = false;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]!;
      const inside = s.point !== null && contains(zone.shape, s.point);
      if (!inside) {
        // An untracked sample ends nothing: the animal may still be there.
        if (s.point !== null) {
          presenceStart = null;
          counted = false;
        }
      } else {
        if (presenceStart === null) presenceStart = s.timeS;
        if (!counted && s.timeS - presenceStart >= minEntryS) {
          counted = true;
          entries++;
          latencyS ??= presenceStart - t0;
        }
      }
      const next = samples[i + 1];
      if (inside && next && next.timeS - s.timeS <= maxGapS) {
        timeS += next.timeS - s.timeS;
        if (next.point) dist += Math.hypot(next.point.x - s.point!.x, next.point.y - s.point!.y);
      }
    }
    return { zoneId: zone.id, timeS, entries, latencyS, distanceCm: dist };
  });

  for (let i = 0; i + 1 < samples.length; i++) {
    const a = samples[i]!;
    const b = samples[i + 1]!;
    if (!a.point || b.timeS - a.timeS > maxGapS) continue;
    trackedS += b.timeS - a.timeS;
    if (b.point) distanceCm += Math.hypot(b.point.x - a.point.x, b.point.y - a.point.y);
  }
  return { durationS, trackedS, distanceCm, zones: out };
}
