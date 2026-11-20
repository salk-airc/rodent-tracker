import { describe, expect, it } from 'vitest';
import { exportDeepLabCutCsv, importPoseTrack, parseCsv, reviewedPoseObservations, sniffPoseFormat } from '../src/paradigms/barnes/io/pose';
import { registerObservationsToMaze } from '../src/paradigms/barnes/tracking/resolve';
import type { TrackObservation } from '../src/paradigms/barnes/types';
import { makeGeometry } from './helpers/synthetic';

const DLC = [
  'scorer,DLC_resnet50_maze,DLC_resnet50_maze,DLC_resnet50_maze,DLC_resnet50_maze,DLC_resnet50_maze,DLC_resnet50_maze,DLC_resnet50_maze,DLC_resnet50_maze,DLC_resnet50_maze',
  'bodyparts,snout,snout,snout,bodycenter,bodycenter,bodycenter,tailbase,tailbase,tailbase',
  'coords,x,y,likelihood,x,y,likelihood,x,y,likelihood',
  '0,110.5,200.5,0.98,100.0,200.0,0.99,70.0,200.0,0.95',
  '1,112.0,201.0,0.97,101.0,200.5,0.99,71.0,200.5,0.94',
  '2,0.0,0.0,0.10,0.0,0.0,0.08,0.0,0.0,0.05',
  '3,115.0,203.0,0.96,103.0,202.0,0.98,73.0,201.0,0.93',
].join('\n');

const SLEAP = [
  'track,frame_idx,instance.score,nose.x,nose.y,nose.score,thorax.x,thorax.y,thorax.score,tail_base.x,tail_base.y,tail_base.score',
  'track_0,0,0.95,110.5,200.5,0.98,100.0,200.0,0.99,70.0,200.0,0.95',
  'track_0,1,0.94,112.0,201.0,0.97,101.0,200.5,0.99,71.0,200.5,0.94',
  'track_0,2,0.20,0.0,0.0,0.10,0.0,0.0,0.08,0.0,0.0,0.05',
].join('\n');

describe('sniffPoseFormat', () => {
  it('recognizes DeepLabCut by its scorer row', () => {
    expect(sniffPoseFormat(DLC)).toBe('deeplabcut');
  });

  it('recognizes a SLEAP analysis CSV by frame_idx and node columns', () => {
    expect(sniffPoseFormat(SLEAP)).toBe('sleap-analysis-csv');
  });

  it('does not guess at something else', () => {
    expect(sniffPoseFormat('a,b,c\n1,2,3')).toBe('unknown');
  });
});

describe('importing DeepLabCut', () => {
  it('maps body-part names a lab would actually use', () => {
    const r = importPoseTrack(DLC);
    expect(r.format).toBe('deeplabcut');
    // snout -> nose, bodycenter -> body, tailbase -> tail
    expect(r.mapping.find((m) => m.column === 'snout')?.usedAs).toBe('nose');
    expect(r.mapping.find((m) => m.column === 'bodycenter')?.usedAs).toBe('body');
    expect(r.mapping.find((m) => m.column === 'tailbase')?.usedAs).toBe('tail');
  });

  it('reads coordinates onto the right points', () => {
    const r = importPoseTrack(DLC);
    expect(r.observations[0]!.nose).toEqual({ x: 110.5, y: 200.5 });
    expect(r.observations[0]!.body).toEqual({ x: 100, y: 200 });
    expect(r.observations[0]!.tail).toEqual({ x: 70, y: 200 });
  });

  /**
   * The important one. DeepLabCut writes a coordinate for every frame whether or
   * not it saw anything, and a low-likelihood row is usually (0, 0). Taking that
   * at face value puts the animal in the top-left corner of the platform, which
   * is a plausible-looking trajectory and completely wrong.
   */
  it('treats a low-likelihood row as absent rather than as a position', () => {
    const r = importPoseTrack(DLC);
    const absent = r.observations[2]!;
    expect(absent.body).toBeNull();
    expect(absent.nose).toBeNull();
    expect(absent.areaPx).toBe(0);
    expect(r.lowConfidenceFrames).toBe(1);
  });

  it('respects a different likelihood threshold', () => {
    const loose = importPoseTrack(DLC, { minLikelihood: 0.05 });
    expect(loose.observations[2]!.body).toEqual({ x: 0, y: 0 });
    expect(loose.lowConfidenceFrames).toBe(0);
    expect(loose.observations[2]!.axisConfidence).toBeCloseTo(0.05, 6);
  });

  it('computes the nose and tail arm lengths from the imported points', () => {
    const r = importPoseTrack(DLC);
    expect(r.observations[0]!.noseArmPx).toBeCloseTo(Math.hypot(10.5, 0.5), 5);
    expect(r.observations[0]!.tailArmPx).toBeCloseTo(30, 5);
  });

  /**
   * Entry detection normally works from the visible area collapsing, and a pose
   * file has no area. That has to be said rather than left for the user to
   * discover from a wrong escape latency.
   */
  it('warns that entry detection is weaker without an area', () => {
    expect(importPoseTrack(DLC).warnings.join(' ')).toMatch(/visible area/);
  });

  it('refuses a file with no recognizable nose or body', () => {
    const odd = ['scorer,s,s,s', 'bodyparts,leftear,leftear,leftear', 'coords,x,y,likelihood', '0,1,2,0.9'].join('\n');
    expect(() => importPoseTrack(odd)).toThrow(/separate nose and body coordinates/);
    expect(() => importPoseTrack(odd)).toThrow(/leftear/);
  });

  it('copes with a multi-animal file that has an individuals row', () => {
    const multi = [
      'scorer,s,s,s,s,s,s',
      'individuals,mouse1,mouse1,mouse1,mouse1,mouse1,mouse1',
      'bodyparts,nose,nose,nose,thorax,thorax,thorax',
      'coords,x,y,likelihood,x,y,likelihood',
      '0,10,20,0.9,15,25,0.95',
    ].join('\n');
    const r = importPoseTrack(multi);
    expect(r.observations).toHaveLength(1);
    expect(r.observations[0]!.nose).toEqual({ x: 10, y: 20 });
    expect(r.observations[0]!.body).toEqual({ x: 15, y: 25 });
  });

  it('rejects a DeepLabCut file containing more than one animal', () => {
    const two = [
      'scorer,s,s,s,s,s,s,s,s,s,s,s,s',
      'individuals,mouse1,mouse1,mouse1,mouse1,mouse1,mouse1,mouse2,mouse2,mouse2,mouse2,mouse2,mouse2',
      'bodyparts,nose,nose,nose,thorax,thorax,thorax,nose,nose,nose,thorax,thorax,thorax',
      'coords,x,y,likelihood,x,y,likelihood,x,y,likelihood,x,y,likelihood',
      '0,10,20,0.9,15,25,0.95,110,120,0.9,115,125,0.95',
    ].join('\n');
    expect(() => importPoseTrack(two)).toThrow(/2 animals/);
  });

  it('rejects a body-only file instead of relabeling body coordinates as a measured nose', () => {
    const noNose = ['scorer,s,s,s', 'bodyparts,thorax,thorax,thorax', 'coords,x,y,likelihood', '0,50,60,0.9'].join('\n');
    expect(() => importPoseTrack(noNose)).toThrow(/separate nose and body coordinates/);
    expect(() => importPoseTrack(noNose)).toThrow(/invent a measurement/);
  });

  it('rejects coordinates without confidence rather than assuming certainty', () => {
    const noConfidence = [
      'scorer,s,s,s,s',
      'bodyparts,nose,nose,thorax,thorax',
      'coords,x,y,x,y',
      '0,10,20,15,25',
    ].join('\n');
    expect(() => importPoseTrack(noConfidence)).toThrow(/invent evidence/);
  });

  it('treats an invalid confidence as a gap and reports it', () => {
    const invalid = DLC.replace('0.98,100.0', '1.50,100.0');
    const result = importPoseTrack(invalid);
    expect(result.observations[0]!.nose).toBeNull();
    expect(result.observations[0]!.body).toBeNull();
    expect(result.warnings.join(' ')).toMatch(/out-of-range confidence/);
  });

  it('does not coerce blank coordinates to the top-left corner', () => {
    const blank = DLC.replace('110.5,200.5,0.98', ',,0.98');
    const result = importPoseTrack(blank);
    expect(result.observations[0]!.nose).toBeNull();
    expect(result.observations[0]!.body).toBeNull();
  });
});

describe('importing SLEAP', () => {
  it('reads node.x, node.y and node.score triples', () => {
    const r = importPoseTrack(SLEAP);
    expect(r.format).toBe('sleap-analysis-csv');
    expect(r.observations[0]!.nose).toEqual({ x: 110.5, y: 200.5 });
    expect(r.observations[0]!.body).toEqual({ x: 100, y: 200 });
    expect(r.observations[1]!.frame).toBe(1);
  });

  it('treats a low-score row as absent', () => {
    expect(importPoseTrack(SLEAP).observations[2]!.body).toBeNull();
  });

  it('refuses a file that combines more than one track', () => {
    const two = `${SLEAP}\ntrack_1,0,0.90,300.0,300.0,0.95,301.0,301.0,0.95,302.0,302.0,0.95`;
    expect(() => importPoseTrack(two)).toThrow(/2 tracks/);
  });

  it('explains that .slp files need exporting first', () => {
    expect(() => importPoseTrack('\x89HDF\r\n\x1a\n binary junk')).toThrow(/\.slp files are not supported/);
  });
});

describe('registering an imported track to the maze', () => {
  it('computes nearest-hole and radial coordinates from imported points', () => {
    const geometry = makeGeometry();
    const imported = importPoseTrack(DLC).observations;
    const point = geometry.holes[0]!.center;
    const positioned = registerObservationsToMaze(
      [{ ...imported[0]!, nose: point, body: point }],
      geometry,
    )[0]!;
    expect(positioned.nearestHole).toBe(0);
    expect(positioned.nearestHoleDistPx).toBe(0);
    expect(positioned.radialFraction).toBeCloseTo(geometry.ringRadiusPx / geometry.platformRadiusPx, 6);
  });

  it('keeps missing positions explicitly unregistered', () => {
    const absent = registerObservationsToMaze([importPoseTrack(DLC).observations[2]!], makeGeometry())[0]!;
    expect(absent.nearestHole).toBe(-1);
    expect(absent.nearestHoleDistPx).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('exporting DeepLabCut', () => {
  const obs = (frame: number, present: boolean): TrackObservation => ({
    frame,
    areaMeasured: true,
    areaPx: present ? 700 : 0,
    darkPixelsPx: present ? 900 : 0,
    body: present ? { x: 100.25, y: 200.5 } : null,
    nose: present ? { x: 110.25, y: 201.5 } : null,
    tail: present ? { x: 70.25, y: 199.5 } : null,
    thicknessPx: 10,
    noseArmPx: 10,
    tailArmPx: 30,
    nearestHole: 3,
    nearestHoleDistPx: 12,
    radialFraction: 0.8,
    candidateCount: 1,
    reacquired: false,
    axisConfidence: 0.9,
  });

  it('writes the three DeepLabCut header rows', () => {
    const csv = exportDeepLabCutCsv([obs(0, true)], () => 0.95);
    const lines = csv.split('\n');
    expect(lines[0]).toMatch(/^scorer,/);
    expect(lines[1]).toBe('bodyparts,nose,nose,nose,body,body,body,tail,tail,tail');
    expect(lines[2]).toBe('coords,x,y,likelihood,x,y,likelihood,x,y,likelihood');
  });

  /**
   * A missing frame must not be written as (0, 0). That is the same trap as on
   * import, in the other direction: a downstream tool would read it as the animal
   * visiting the corner of the platform.
   */
  it('writes a missing frame as empty rather than as the origin', () => {
    const csv = exportDeepLabCutCsv([obs(0, true), obs(1, false)], () => 0.9);
    const row = csv.split('\n')[4]!;
    expect(row).toBe('1,,,0,,,0,,,0');
    expect(row).not.toMatch(/0\.000/);
  });

  it('round-trips through the importer', () => {
    const csv = exportDeepLabCutCsv([obs(0, true), obs(1, true)], () => 0.95);
    const back = importPoseTrack(csv);
    expect(back.observations).toHaveLength(2);
    expect(back.observations[0]!.nose!.x).toBeCloseTo(110.25, 3);
    expect(back.observations[0]!.body!.y).toBeCloseTo(200.5, 3);
    expect(back.observations[0]!.tail!.x).toBeCloseTo(70.25, 3);
  });

  it('exports reviewed points while leaving inferred and lost frames blank', () => {
    const observations = [obs(0, true), obs(1, true), obs(2, true)];
    const base = {
      status: 'tracked' as const,
      body: { x: 100, y: 200 },
      nose: { x: 110, y: 200 },
      areaPx: 700,
      areaMeasured: true,
      holeIndex: null,
      confidence: 1,
      interpolated: false,
      statusProvenance: 'auto' as const,
      bodyProvenance: 'auto' as const,
      noseProvenance: 'auto' as const,
      provenance: 'auto' as const,
    };
    const reviewed = reviewedPoseObservations(observations, [
      { frame: 0, ...base, body: { x: 123, y: 234 }, bodyProvenance: 'manual' },
      { frame: 1, ...base, interpolated: true },
      { frame: 2, ...base, status: 'lost', body: null, nose: null },
    ]);
    const rows = parseCsv(exportDeepLabCutCsv(reviewed, () => 1));

    expect(rows[3]!.slice(4, 6)).toEqual(['123.000', '234.000']);
    expect(rows[4]).toEqual(['1', '', '', '0', '', '', '0', '', '', '0']);
    expect(rows[5]).toEqual(['2', '', '', '0', '', '', '0', '', '', '0']);
  });
});

describe('parseCsv', () => {
  it('handles quoted fields with commas and embedded quotes', () => {
    const rows = parseCsv('a,"b,c","say ""hi"""\n1,2,3\n');
    expect(rows[0]).toEqual(['a', 'b,c', 'say "hi"']);
    expect(rows[1]).toEqual(['1', '2', '3']);
  });

  it('handles CRLF and drops a trailing blank row', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('what an imported track costs', () => {
  /**
   * The honest-degradation property, and the reason the import warns.
   *
   * Entry detection works from the animal's visible area collapsing. A pose file
   * has no area, so an escape that this tool would have timed becomes
   * undetectable. The right behavior is for the latency to come back censored,
   * meaning "at least this long, we did not see it happen" — not for it to come
   * back as a plausible number that is wrong.
   *
   * Confirmed on real data with tools/probes/pose-roundtrip.ts: exporting
   * test53's own track and importing it back turns its total latency from
   * 23.333 s observed into 25.200 s censored, while every position survives
   * exactly. This test reproduces the mechanism without needing video.
   */
  it('turns an escape from measured into censored, rather than into a wrong number', () => {
    const withArea: TrackObservation[] = [];
    for (let frame = 0; frame < 60; frame++) {
      const entering = frame >= 30;
      withArea.push({
        frame,
        areaMeasured: true,
        // The area collapse that is the evidence for an entry.
        areaPx: entering ? 150 : 700,
        darkPixelsPx: entering ? 150 : 700,
        body: { x: 100, y: 100 },
        nose: { x: 105, y: 100 },
        tail: { x: 80, y: 100 },
        thicknessPx: 10,
        noseArmPx: 5,
        tailArmPx: 20,
        nearestHole: 0,
        nearestHoleDistPx: 5,
        radialFraction: 0.9,
        candidateCount: 1,
        reacquired: false,
        axisConfidence: 0.9,
      });
    }

    const csv = exportDeepLabCutCsv(withArea, () => 0.95);
    const imported = importPoseTrack(csv);

    // Positions come back exactly.
    expect(imported.observations).toHaveLength(60);
    expect(imported.observations[45]!.body).toEqual({ x: 100, y: 100 });

    // But the area collapse does not survive, because there is nowhere in a pose
    // file to put it. It stays explicitly unmeasured rather than being replaced
    // by a plausible constant body area.
    expect(new Set(imported.observations.map((o) => o.areaPx))).toEqual(new Set([0]));
    expect(imported.observations.every((o) => o.areaMeasured === false)).toBe(true);

    // Which is why the import says so.
    expect(imported.warnings.join(' ')).toMatch(/visible area/);
  });
});
