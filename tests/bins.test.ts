import { describe, expect, it } from 'vitest';
import { openFieldZones } from '../src/arena/arena';
import { scaleFromTwoPoints } from '../src/arena/calibration';
import { yMaze } from '../src/arena/armMaze';
import { measureZones, zoneVisits, type WorldSample } from '../src/arena/zoneMeasures';
import { binReports, type ParadigmReport } from '../src/paradigm';
import { trackFromPositions, type PositionSample } from '../src/tracking/arenaTrack';
import { openField } from '../src/paradigms/open-field';
import { yMazeAlternation } from '../src/paradigms/y-maze';
import type { Point } from '../src/types';
import { PathBuilder } from './helpers/arenaVideo';

const value = (r: ParadigmReport, id: string) => r.values.find((v) => v.id === id)!.value as number;
/** A track straight from world-cm positions at 30 fps, unsmoothed, so bins can be checked exactly. */
function track(path: ReadonlyArray<Point>, arena: Parameters<typeof trackFromPositions>[1]) {
  const samples: PositionSample[] = path.map((p, i) => ({ frame: i, timeS: i / 30, body: p }));
  return trackFromPositions(samples, arena, { space: 'world', smoothFrames: 1 });
}

describe('zone measures from part-way through', () => {
  const zones = openFieldZones(40, 40).zones;
  const at = (timeS: number, x: number): WorldSample => ({ timeS, point: { x, y: 20 } });

  it('can leave a presence already under way uncounted', () => {
    const samples = [at(0, 20), at(1, 21), at(2, 2), at(3, 20)];
    expect(measureZones(samples, zones, { maxGapS: 2 }).zones[0]!.entries).toBe(2);
    const later = measureZones(samples, zones, { maxGapS: 2, countStartInside: false }).zones[0]!;
    expect(later.entries).toBe(1);
    expect(later.latencyS).toBe(3);
    expect(later.timeS).toBe(2); // 0→1 and 1→2: the time inside still counts
    expect(zoneVisits(samples, zones, { countStartInside: false }).map((v) => v.startS)).toEqual([3]);
  });
});

describe('time bins', () => {
  const field = { ...openFieldZones(40, 40), calibration: scaleFromTwoPoints({ x: 0, y: 0 }, { x: 200, y: 0 }, 40) };
  // 8 s: along the wall, into the center at about 2.75 s, stays until about 7 s, out.
  const walk = new PathBuilder({ x: 4, y: 4 }).to({ x: 36, y: 4 }, 2).to({ x: 20, y: 20 }, 2).stay(2).to({ x: 36, y: 36 }, 2).points;

  it('splits a session into bins that add up to the whole', () => {
    const t = track(walk, field);
    const whole = openField.report(openField.score(t, { arena: field }));
    const bins = binReports(openField, t, { arena: field }, 2);
    expect(bins.map((b) => [b.startS, b.endS])).toEqual([[0, 2], [2, 4], [4, 6], [6, 239 / 30]]);
    const sum = (id: string) => bins.reduce((s, b) => s + value(b.report, id), 0);
    expect(sum('distance_cm')).toBeCloseTo(value(whole, 'distance_cm'), 6);
    expect(sum('center_time_s')).toBeCloseTo(value(whole, 'center_time_s'), 6);
    expect(sum('near_wall_time_s')).toBeCloseTo(value(whole, 'near_wall_time_s'), 6);
    // One entry, in the bin it happened in; staying across the next edge isn't another.
    expect(bins.map((b) => value(b.report, 'center_entries'))).toEqual([0, 1, 0, 0]);
    expect(value(bins[1]!.report, 'center_latency_s')).toBeCloseTo(value(whole, 'center_latency_s') - 2, 6);
  });

  it('gives a sequence paradigm its own sequence per bin', () => {
    const layout = yMaze();
    const arena = { ...layout, calibration: scaleFromTwoPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, 20) };
    const tip = (id: string) => {
      const w = layout.landmarks.find((l) => l.id === `${id}:tip`)!.world;
      return { x: w.x * 0.8, y: w.y * 0.8 };
    };
    const hub = { x: 0, y: 0 };
    const path = new PathBuilder(hub);
    for (const arm of ['A', 'B', 'C', 'A', 'B', 'C']) path.to(tip(arm), 0.5).stay(0.5).to(hub, 0.5);
    const t = track(path.points, arena);
    const bins = binReports(yMazeAlternation, t, { arena }, 4.5);
    expect(bins).toHaveLength(2);
    expect(bins.map((b) => b.report.values.find((v) => v.id === 'arm_sequence')!.value)).toEqual(['A B C', 'A B C']);
    expect(bins.map((b) => value(b.report, 'alternations'))).toEqual([1, 1]);
  });
});
