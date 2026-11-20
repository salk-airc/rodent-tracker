import { describe, expect, it } from 'vitest';
import { detectEvents } from '../src/events';
import { DEFAULT_PARAMS } from '../src/params';
import { resolveTrack, type ManualCorrection } from '../src/tracking/resolve';
import type { Point, TrackObservation } from '../src/types';
import { BODY_AREA_PX, makeGeometry, makeTimebase } from './helpers/synthetic';

const geometry = makeGeometry(3);

function observation(frame: number, point: Point | null, areaPx = point ? BODY_AREA_PX : 0): TrackObservation {
  const nearest = point
    ? geometry.holes.reduce((best, hole) => {
        const distance = Math.hypot(point.x - hole.center.x, point.y - hole.center.y);
        return distance < best.distance ? { index: hole.index, distance } : best;
      }, { index: -1, distance: Number.POSITIVE_INFINITY })
    : { index: -1, distance: Number.POSITIVE_INFINITY };
  return {
    frame,
    areaMeasured: true,
    areaPx,
    darkPixelsPx: areaPx,
    body: point,
    nose: point,
    tail: point,
    thicknessPx: 8,
    noseArmPx: 0,
    tailArmPx: 0,
    nearestHole: nearest.index,
    nearestHoleDistPx: nearest.distance,
    radialFraction: point ? Math.hypot(point.x - geometry.center.x, point.y - geometry.center.y) / geometry.platformRadiusPx : Number.NaN,
    candidateCount: point ? 1 : 0,
    reacquired: false,
    axisConfidence: point ? 1 : 0,
  };
}

function resolve(observations: TrackObservation[], corrections?: ReadonlyMap<number, ManualCorrection>) {
  return resolveTrack({
    observations,
    corrections,
    geometry,
    timebase: makeTimebase(observations.length),
    params: { ...DEFAULT_PARAMS, smoothingWindowFrames: 1, maxInterpolateGapFrames: 0 },
    bodyAreaPx: BODY_AREA_PX,
    positionProvenance: 'auto',
    trialStart: { frame: 0, reason: 'fileStart', provenance: 'auto', evidence: 'test' },
  });
}

describe('manual correction invariants', () => {
  it('clears stale positions when a person marks a tracked frame lost', () => {
    const point = geometry.holes[3]!.center;
    const track = resolve(
      [observation(0, point)],
      new Map([[0, { frame: 0, status: 'lost' }]]),
    );
    expect(track.frames[0]).toMatchObject({ status: 'lost', body: null, nose: null, holeIndex: null, provenance: 'manual' });
  });

  it('never reclassifies an explicit lost correction as inside a hole', () => {
    const point = geometry.holes[3]!.center;
    const track = resolve(
      [observation(0, point), observation(1, null), observation(2, point)],
      new Map([[1, { frame: 1, status: 'lost' }]]),
    );

    expect(track.frames[1]).toMatchObject({ status: 'lost', provenance: 'manual' });
    expect(track.gaps).toEqual([
      expect.objectContaining({ startFrame: 1, endFrame: 1, verdict: 'lost', holeIndex: null }),
    ]);
  });

  it('does not allow a positionless frame to be labeled tracked', () => {
    const track = resolve(
      [observation(0, null)],
      new Map([[0, { frame: 0, status: 'tracked' }]]),
    );
    expect(track.frames[0]).toMatchObject({ status: 'lost', body: null, nose: null });
  });

  it('changes only the marker a person supplied and keeps the other measured marker', () => {
    const body = { x: 100, y: 110 };
    const measuredNose = { x: 105, y: 110 };
    const correctedNose = { x: 108, y: 112 };
    const source = { ...observation(0, body), nose: measuredNose };
    const track = resolve(
      [source],
      new Map([[0, { frame: 0, nose: correctedNose, note: 'Nose moved by hand.' }]]),
    );

    expect(track.frames[0]).toMatchObject({
      status: 'tracked',
      body,
      nose: correctedNose,
      provenance: 'manual',
    });
    expect(track.frames[0]!.body).not.toEqual(correctedNose);
  });

  it('attributes a nose-defined visit only to edits of the nose or entry label', () => {
    const atHole = geometry.holes[3]!.center;
    const observations = Array.from({ length: 20 }, (_, frame) => observation(frame, atHole));
    const eventsFor = (track: ReturnType<typeof resolve>) => detectEvents({
      frames: track.frames,
      geometry,
      params: DEFAULT_PARAMS,
      timebase: makeTimebase(observations.length),
      bodyAreaPx: BODY_AREA_PX,
      trialStartFrame: 0,
    }).events;

    const bodyOnly = resolve(
      observations,
      new Map([[10, { frame: 10, body: { x: atHole.x - 5, y: atHole.y } }]]),
    );
    expect(bodyOnly.frames[10]).toMatchObject({
      bodyProvenance: 'manual',
      noseProvenance: 'auto',
      statusProvenance: 'auto',
    });
    expect(eventsFor(bodyOnly).find((event) => event.type === 'investigation')?.provenance).toBe('auto');

    const noseOnly = resolve(
      observations,
      new Map([[10, { frame: 10, nose: { x: atHole.x + 2, y: atHole.y } }]]),
    );
    expect(noseOnly.frames[10]).toMatchObject({
      bodyProvenance: 'auto',
      noseProvenance: 'manual',
      statusProvenance: 'auto',
    });
    expect(eventsFor(noseOnly).find((event) => event.type === 'investigation')?.provenance).toBe('manual');
  });

  it('snaps a manual inside-hole label to the selected hole', () => {
    const track = resolve(
      [observation(0, geometry.center)],
      new Map([[0, { frame: 0, status: 'inHole', holeIndex: 7 }]]),
    );
    expect(track.frames[0]).toMatchObject({
      status: 'inHole',
      body: geometry.holes[7]!.center,
      nose: geometry.holes[7]!.center,
      holeIndex: 7,
    });
  });

  it('does not turn a hole-only correction into manual entry evidence', () => {
    const atHole = geometry.holes[3]!.center;
    const observations = [
      ...Array.from({ length: 20 }, (_, frame) => observation(frame, atHole)),
      ...Array.from({ length: 30 }, (_, offset) => observation(20 + offset, null)),
      observation(50, atHole),
    ];
    const track = resolve(
      observations,
      new Map([[25, { frame: 25, holeIndex: 7 }]]),
    );

    expect(track.frames[25]).toMatchObject({
      status: 'inHole',
      holeIndex: 3,
      statusProvenance: 'auto',
      provenance: 'auto',
    });
    const events = detectEvents({
      frames: track.frames,
      geometry,
      params: DEFAULT_PARAMS,
      timebase: makeTimebase(observations.length),
      bodyAreaPx: BODY_AREA_PX,
      trialStartFrame: 0,
    });
    expect(events.events.every((event) => event.provenance !== 'manual')).toBe(true);
    expect(events.events.every((event) => !event.evidence.startsWith('Manual'))).toBe(true);
  });

  it('removes a corrected absence from the gap report', () => {
    const point = geometry.center;
    const track = resolve(
      [observation(0, point), observation(1, null), observation(2, point)],
      new Map([[1, { frame: 1, status: 'tracked', body: point, nose: point }]]),
    );
    expect(track.gaps).toEqual([]);
    expect(track.quality.longestGapFrames).toBe(0);
    expect(track.frames[1]).toMatchObject({ status: 'tracked', provenance: 'manual' });
  });

  it('lets a person place a body point on a lost frame without inventing a nose', () => {
    const point = geometry.center;
    const track = resolve(
      [observation(0, null)],
      new Map([[0, { frame: 0, status: 'tracked', body: point }]]),
    );
    expect(track.frames[0]).toMatchObject({
      status: 'tracked',
      body: point,
      nose: null,
      provenance: 'manual',
    });
  });

  it('does not let a correction move a frame across the trial boundary', () => {
    const point = geometry.holes[3]!.center;
    const observations = [observation(0, point), observation(1, point), observation(2, point)];
    const track = resolveTrack({
      observations,
      corrections: new Map([[0, { frame: 0, status: 'inHole', holeIndex: 3 }]]),
      geometry,
      timebase: makeTimebase(observations.length),
      params: { ...DEFAULT_PARAMS, smoothingWindowFrames: 1, maxInterpolateGapFrames: 0 },
      bodyAreaPx: BODY_AREA_PX,
      positionProvenance: 'auto',
      trialStart: { frame: 2, reason: 'manual', provenance: 'manual', evidence: 'test' },
    });

    expect(track.frames[0]).toMatchObject({ status: 'preTrial', body: null, nose: null, provenance: 'auto' });
    expect(track.quality.preTrialFrames).toBe(2);
  });
});

describe('maze re-registration', () => {
  it('recomputes hole distance after an outline moves', () => {
    const point = geometry.holes[3]!.center;
    const stale = observation(0, point, BODY_AREA_PX * 0.3);
    const shifted = {
      ...geometry,
      center: { x: geometry.center.x + 600, y: geometry.center.y },
      holes: geometry.holes.map((hole) => ({
        ...hole,
        center: { x: hole.center.x + 600, y: hole.center.y },
      })),
    };
    const track = resolveTrack({
      observations: [stale],
      geometry: shifted,
      timebase: makeTimebase(1),
      params: { ...DEFAULT_PARAMS, smoothingWindowFrames: 1, maxInterpolateGapFrames: 0 },
      bodyAreaPx: BODY_AREA_PX,
      positionProvenance: 'auto',
      trialStart: { frame: 0, reason: 'fileStart', provenance: 'auto', evidence: 'test' },
    });
    expect(stale.nearestHoleDistPx).toBe(0);
    expect(track.frames[0]!.status).toBe('tracked');
  });
});

describe('tracking provenance', () => {
  it('keeps imported pose positions distinct from native video tracking', () => {
    const point = geometry.holes[3]!.center;
    const observations = [observation(0, point)];
    const track = resolveTrack({
      observations,
      positionProvenance: 'imported',
      geometry,
      timebase: makeTimebase(observations.length),
      params: { ...DEFAULT_PARAMS, smoothingWindowFrames: 1, maxInterpolateGapFrames: 0 },
      bodyAreaPx: BODY_AREA_PX,
      trialStart: { frame: 0, reason: 'fileStart', provenance: 'auto', evidence: 'test' },
    });
    expect(track.frames[0]!.provenance).toBe('imported');
  });
});

describe('terminal tracking gaps', () => {
  it('keeps an unexplained terminal disappearance lost and creates no entry', () => {
    const atHole = geometry.holes[3]!.center;
    const observations = [
      ...Array.from({ length: 20 }, (_, frame) => observation(frame, atHole)),
      ...Array.from({ length: 20 }, (_, offset) => observation(20 + offset, null)),
    ];
    const track = resolve(observations);
    expect(track.gaps[0]).toMatchObject({ verdict: 'lost', holeIndex: 3 });
    expect(track.frames.slice(20).every((frame) => frame.status === 'lost')).toBe(true);

    const events = detectEvents({
      frames: track.frames,
      geometry,
      params: DEFAULT_PARAMS,
      timebase: makeTimebase(observations.length),
      bodyAreaPx: BODY_AREA_PX,
      trialStartFrame: 0,
    });
    expect(events.events.filter((event) => event.type === 'entry')).toHaveLength(0);
  });
});

describe('interpolation boundaries', () => {
  it('does not let an inferred point move a measured point during smoothing', () => {
    const a = { x: geometry.center.x - 100, y: geometry.center.y };
    const b = { x: geometry.center.x + 100, y: geometry.center.y };
    const observations = [observation(0, a), observation(1, null), observation(2, b)];
    const track = resolveTrack({
      observations,
      geometry,
      timebase: makeTimebase(observations.length),
      params: { ...DEFAULT_PARAMS, smoothingWindowFrames: 5, maxInterpolateGapFrames: 1 },
      bodyAreaPx: BODY_AREA_PX,
      positionProvenance: 'auto',
      trialStart: { frame: 0, reason: 'fileStart', provenance: 'auto', evidence: 'test' },
    });

    expect(track.frames[1]!.interpolated).toBe(true);
    expect(track.frames[0]!.body).toEqual(a);
    expect(track.frames[2]!.body).toEqual(b);
  });
});
