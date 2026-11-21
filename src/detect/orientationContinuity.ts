/**
 * Fixes short runs where the nose end could not be told from the tail end,
 * using the frames just before and after. From the AIRC Barnes Maze Review
 * tracker, behavior unchanged.
 *
 * Only runs where the full-resolution taper (v2) produced both endpoints are
 * touched, and only when the observed nose directions on both sides agree and
 * are close in time. Raw observations are left as they were; the result is a
 * new list.
 */

import type { Point } from '../types';

export interface NoseTrackEntry {
  readonly timeS: number;
  /** Body position, or null when no animal was found. */
  readonly body: Point | null;
  readonly bodyObserved?: boolean;
  readonly nose: { readonly point: Point; readonly status: 'observed' | 'ambiguous'; readonly confidence: number } | null;
  readonly method?: 'silhouette-tail-asymmetry-v1' | 'adaptive-source-detail-tail-taper-v2';
  readonly reason?: string;
  /** Both silhouette endpoints, when the v2 taper produced them. */
  readonly endpoints: { readonly primary: Point; readonly alternative: Point } | null;
}

export interface ResolvedNose {
  readonly nose: NoseTrackEntry['nose'];
  readonly reason: string | undefined;
  readonly changed: boolean;
}

const unitDirection = (body: Point | null, point: Point): Point | null => {
  if (!body) return null;
  const x = point.x - body.x;
  const y = point.y - body.y;
  const length = Math.hypot(x, y);
  return length <= 0 ? null : { x: x / length, y: y / length };
};

const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;

export function resolveNoseOrientationContinuity(
  track: ReadonlyArray<NoseTrackEntry | undefined>,
  maximumAnchorSpanS = 0.3,
): ResolvedNose[] {
  const resolved: ResolvedNose[] = Array.from(track, (e) => ({ nose: e?.nose ?? null, reason: e?.reason, changed: false }));
  const isResolvable = (i: number) => {
    const e = track[i];
    return (
      !!e &&
      e.nose?.status === 'ambiguous' &&
      e.method === 'adaptive-source-detail-tail-taper-v2' &&
      e.bodyObserved !== false &&
      e.body !== null &&
      e.endpoints !== null
    );
  };

  let index = 0;
  while (index < track.length) {
    if (!isResolvable(index)) {
      index++;
      continue;
    }
    const runStart = index;
    while (index < track.length && isResolvable(index)) index++;
    const runEnd = index - 1;
    const before = resolved[runStart - 1]?.nose;
    const after = resolved[runEnd + 1]?.nose;
    const beforeEntry = track[runStart - 1];
    const afterEntry = track[runEnd + 1];
    if (
      !before || !after || !beforeEntry || !afterEntry ||
      before.status !== 'observed' || after.status !== 'observed' ||
      afterEntry.timeS - beforeEntry.timeS > maximumAnchorSpanS
    ) {
      continue;
    }
    const beforeDirection = unitDirection(beforeEntry.body, before.point);
    const afterDirection = unitDirection(afterEntry.body, after.point);
    if (!beforeDirection || !afterDirection || dot(beforeDirection, afterDirection) < 0.7) continue;
    const anchor = { x: beforeDirection.x + afterDirection.x, y: beforeDirection.y + afterDirection.y };
    const anchorLength = Math.hypot(anchor.x, anchor.y);
    if (anchorLength <= 0) continue;
    anchor.x /= anchorLength;
    anchor.y /= anchorLength;

    const choices = [];
    for (let i = runStart; i <= runEnd; i++) {
      const e = track[i]!;
      const pair = e.endpoints!;
      const p = unitDirection(e.body, pair.primary);
      const a = unitDirection(e.body, pair.alternative);
      if (!p || !a) {
        choices.push(null);
        continue;
      }
      const ps = dot(p, anchor);
      const as = dot(a, anchor);
      choices.push({ point: ps >= as ? pair.primary : pair.alternative, score: Math.max(ps, as), advantage: Math.abs(ps - as) });
    }
    if (choices.some((c) => c === null || c.score < 0.75 || c.advantage < 0.5)) continue;
    choices.forEach((c, offset) => {
      resolved[runStart + offset] = {
        nose: {
          point: c!.point,
          status: 'observed',
          confidence: Math.round(Math.min(0.85, before.confidence, after.confidence, c!.score) * 1000) / 1000,
        },
        reason: 'brief taper ambiguity resolved from agreeing nose directions in adjacent observed frames',
        changed: true,
      };
    });
  }
  return resolved;
}
