/**
 * The engine's three parts as separate pieces: arena finders, tracks from
 * another tracker, and the common report every paradigm returns.
 */

import { describe, expect, it } from 'vitest';
import { findBoxArena, findRoundArena, CONFIDENT_FIT } from '../src/arena/find';
import { openFieldZones } from '../src/arena/arena';
import { scaleFromTwoPoints, toImage, toWorld } from '../src/arena/calibration';
import { elevatedPlusMaze, yMaze } from '../src/arena/armMaze';
import { contains, type Shape } from '../src/arena/shapes';
import type { Gray } from '../src/image/imageOps';
import { trackFromPositions, type PositionSample } from '../src/tracking/arenaTrack';
import { reportRows } from '../src/paradigm';
import { openField } from '../src/paradigms/open-field';
import { elevatedPlus } from '../src/paradigms/elevated-plus';
import { yMazeAlternation } from '../src/paradigms/y-maze';
import type { Point } from '../src/types';
import { arenaRecording, PathBuilder } from './helpers/arenaVideo';

/** A gray image: pixels inside bright, the rest dark. Pixel (x, y) is the point (x, y). */
function image(width: number, height: number, inside: (p: Point) => boolean): Gray {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = inside({ x, y }) ? 200 : 35;
  return { data, width, height };
}

describe('arena finders', () => {
  it('finds a round arena and its scale from the diameter alone', () => {
    // A 120 cm pool imaged 240 px across: 2 px/cm, centered at (200, 150).
    const bg = image(400, 300, (p) => Math.hypot(p.x - 200, p.y - 150) <= 120);
    const fit = findRoundArena(bg, { diameterCm: 120 });
    expect(fit.confidence).toBeGreaterThan(CONFIDENT_FIT);
    expect(fit.warnings).toEqual([]);
    const cal = fit.arena!.calibration;
    expect(toImage(cal, { x: 0, y: 0 }).x).toBeCloseTo(200, 0);
    expect(toImage(cal, { x: 0, y: 0 }).y).toBeCloseTo(150, 0);
    expect(toWorld(cal, { x: 320, y: 150 }).x).toBeCloseTo(60, 0);
    expect(fit.arena!.zones.map((z) => z.id)).toEqual(['center', 'periphery']);
    expect(fit.landmarks).toHaveLength(4);
  });

  it('says so when there is no arena to find', () => {
    const fit = findRoundArena({ data: new Uint8Array(64 * 48).fill(90), width: 64, height: 48 }, { diameterCm: 100 });
    expect(fit.arena).toBeNull();
    expect(fit.confidence).toBe(0);
    expect(fit.warnings.length).toBe(1);
  });

  it('finds a box seen at an angle and measures true centimeters inside it', () => {
    // A 40 × 40 cm floor through a tilted camera.
    const truth = [6, 1.2, 70, -0.6, 5.2, 40, 0.0012, 0.0016, 1];
    const project = (p: Point): Point => {
      const w = truth[6]! * p.x + truth[7]! * p.y + truth[8]!;
      return { x: (truth[0]! * p.x + truth[1]! * p.y + truth[2]!) / w, y: (truth[3]! * p.x + truth[4]! * p.y + truth[5]!) / w };
    };
    const floor: Shape = { kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }].map(project) };
    const fit = findBoxArena(image(400, 300, (p) => contains(floor, p)), { widthCm: 40, heightCm: 40 });
    expect(fit.confidence).toBeGreaterThan(CONFIDENT_FIT);
    expect(fit.warnings).toEqual([]);
    for (const world of [{ x: 10, y: 30 }, { x: 20, y: 20 }, { x: 35, y: 5 }]) {
      const back = toWorld(fit.arena!.calibration, project(world));
      expect(Math.hypot(back.x - world.x, back.y - world.y)).toBeLessThan(0.5);
    }
  });

  it('warns when the box does not have the shape it was said to have', () => {
    const bg = image(400, 300, (p) => p.x > 50 && p.x < 350 && p.y > 100 && p.y < 200);
    const fit = findBoxArena(bg, { widthCm: 40, heightCm: 40 });
    expect(fit.warnings.some((w) => /looks 3\.0\d:1/.test(w))).toBe(true);
    expect(fit.confidence).toBeLessThan(CONFIDENT_FIT);
  });
});

/** 5 px/cm, world origin at (60, 20) in a 320 × 240 image. */
const W = 320;
const H = 240;
const camera = scaleFromTwoPoints({ x: 60, y: 20 }, { x: 260, y: 20 }, 40);

describe('tracks from another tracker', () => {
  const arena = { ...openFieldZones(40, 40), calibration: camera };
  const path = new PathBuilder({ x: 4, y: 4 }).to({ x: 36, y: 4 }, 2).to({ x: 20, y: 20 }, 2).stay(2).to({ x: 36, y: 36 }, 2).points;

  it('scores imported positions exactly as the same positions found in the video', async () => {
    const fromVideo = await openField.analyze(arenaRecording(arena, W, H, path), { arena });
    const samples: PositionSample[] = fromVideo.frames.map((f) => ({ frame: f.frame, timeS: f.timeS, body: f.bodyPx, nose: f.nosePx }));
    const track = trackFromPositions(samples, arena, { sourceId: 'sleap' });
    expect(track.source).toBe('imported');
    const imported = openField.score(track, { arena });
    expect(imported.summary).toEqual(fromVideo.summary);
    expect(imported.detectorId).toBe('sleap');
  });

  it('takes positions already in world cm, and treats missing ones as untracked', () => {
    const samples: PositionSample[] = path.map((p, i) => ({ frame: i, timeS: i / 30, body: i % 10 === 0 ? null : p }));
    const track = trackFromPositions(samples, arena, { space: 'world', smoothFrames: 1 });
    expect(track.trackedFraction).toBeCloseTo(0.9, 1);
    expect(track.frames[1]!.body!.x).toBeCloseTo(path[1]!.x, 9);
    expect(track.frames[0]!.zones).toEqual([]);
    const result = openField.score(track, { arena });
    expect(result.summary.zones[0]!.entries).toBe(1);
  });
});

describe('common report', () => {
  it('reports one value per defined metric, in order, for every arena paradigm', async () => {
    const field = { ...openFieldZones(40, 40), calibration: camera };
    const walk = new PathBuilder({ x: 4, y: 4 }).to({ x: 20, y: 20 }, 2).stay(1).points;
    const of = openField.report(await openField.analyze(arenaRecording(field, W, H, walk), { arena: field }));

    const plus = { ...elevatedPlusMaze(), calibration: scaleFromTwoPoints({ x: 160, y: 120 }, { x: 260, y: 120 }, 20) };
    const plusWalk = new PathBuilder({ x: 0, y: 0 }).to({ x: 0, y: -20 }, 1).stay(1).to({ x: 0, y: 0 }, 1).points;
    const epm = elevatedPlus.report(await elevatedPlus.analyze(arenaRecording(plus, W, H, plusWalk), { arena: plus }));

    const y = { ...yMaze(), calibration: scaleFromTwoPoints({ x: 160, y: 120 }, { x: 260, y: 120 }, 25) };
    const yWalk = new PathBuilder({ x: 0, y: 0 }).stay(0.5).points;
    const ym = yMazeAlternation.report(await yMazeAlternation.analyze(arenaRecording(y, W, H, yWalk), { arena: y }));

    for (const [paradigm, report] of [[openField, of], [elevatedPlus, epm], [yMazeAlternation, ym]] as const) {
      expect(report.paradigmId).toBe(paradigm.id);
      expect(report.values.map((v) => v.id)).toEqual(paradigm.metrics.map((m) => m.id));
      const rows = reportRows(paradigm, report);
      expect(rows.every((r) => r.label && r.unit && r.definition)).toBe(true);
    }
    // A test that never happened is reported as missing, not as zero.
    const alternation = ym.values.find((v) => v.id === 'alternation_pct')!;
    expect(alternation).toMatchObject({ value: null, complete: false });
    expect(epm.values.find((v) => v.id === 'open_arm_time_pct')!.complete).toBe(true);
  });
});
