import { describe, expect, it } from 'vitest';
import { openFieldZones } from '../src/arena/arena';
import { scaleFromTwoPoints } from '../src/arena/calibration';
import { findBoxArena } from '../src/arena/find';
import { silhouetteTaperDetector } from '../src/detect/silhouetteTaper';
import { asDarkerAnimal, buildArenaBackground, invertGray } from '../src/image/contrast';
import { openField } from '../src/paradigms/open-field';
import { barnesMaze } from '../src/paradigms/barnes';
import { DEFAULT_PARAMS } from '../src/paradigms/barnes/params';
import { arenaRecording, DARK_MOUSE, LIGHT_MOUSE, PathBuilder } from './helpers/arenaVideo';
import { makeGeometry } from './helpers/synthetic';

const W = 320;
const H = 240;
/** A 40 × 40 cm box at 5 px/cm, top-left at (60, 20). */
const arena = { ...openFieldZones(40, 40), calibration: scaleFromTwoPoints({ x: 60, y: 20 }, { x: 260, y: 20 }, 40) };
const walk = new PathBuilder({ x: 4, y: 4 }).to({ x: 36, y: 4 }, 2).to({ x: 20, y: 20 }, 2).stay(2).to({ x: 36, y: 36 }, 2).points;

describe('animal contrast', () => {
  it('mismeasures an albino mouse on a dark floor unless told it is lighter', async () => {
    const light = arenaRecording(arena, W, H, walk, LIGHT_MOUSE);
    const dark = await openField.analyze(arenaRecording(arena, W, H, walk, DARK_MOUSE), { arena });
    // Read as a dark animal, the bright mouse bakes into the background where it
    // rests, and the floor it uncovers is tracked instead: about 80 cm comes out as a few.
    const asDark = await openField.analyze(light, { arena });
    expect(asDark.summary.distanceCm).toBeLessThan(0.2 * dark.summary.distanceCm);

    const asLight = await openField.analyze(light, { arena, animalContrast: 'lighter' });
    expect(asLight.summary.trackedFraction).toBe(1);
    // The same walk, drawn in the opposite gray levels, measures the same.
    expect(asLight.summary.distanceCm).toBeCloseTo(dark.summary.distanceCm, 0);
    expect(asLight.summary.zones[0]!.entries).toBe(dark.summary.zones[0]!.entries);
    expect(asLight.summary.zones[0]!.timeS).toBeCloseTo(dark.summary.zones[0]!.timeS, 1);
  });

  it('finds either kind of mouse with `either`, including on a near-black floor', async () => {
    const veryDarkFloor = { floor: 15, offArena: 180, mouse: 225 };
    for (const colors of [DARK_MOUSE, LIGHT_MOUSE, veryDarkFloor]) {
      const result = await openField.analyze(arenaRecording(arena, W, H, walk, colors), { arena, animalContrast: 'either' });
      expect(result.summary.trackedFraction).toBe(1);
      expect(result.summary.zones[0]!.entries).toBe(1);
    }
    const taper = await openField.analyze(
      arenaRecording(arena, W, H, walk, veryDarkFloor),
      { arena, animalContrast: 'either' },
      { detector: silhouetteTaperDetector },
    );
    expect(taper.summary.trackedFraction).toBe(1);
  });

  it('keeps a still light mouse out of its background, and shows it darker to detectors', async () => {
    // Parked in one spot for 60% of the recording, which a median would bake in.
    const parked = new PathBuilder({ x: 30, y: 30 }).stay(6).to({ x: 10, y: 10 }, 1).stay(3).points;
    const source = arenaRecording(arena, W, H, parked, LIGHT_MOUSE);
    const bg = await buildArenaBackground(source, 'lighter');
    const at = 30 * 5 + 20; // the mouse's row, world y 30 cm
    expect(bg.image.data[at * W + 60 + 150]).toBe(LIGHT_MOUSE.floor);
    const seen = asDarkerAnimal(source, bg.image, 'lighter');
    const frame = await seen.source.getGrayFrame(0);
    expect(frame[at * W + 60 + 150]).toBeLessThan(seen.background.data[at * W + 60 + 150]!);
  });

  it('finds a dark floor when told to', async () => {
    const source = arenaRecording(arena, W, H, walk.map(() => null), LIGHT_MOUSE);
    const bg = await buildArenaBackground(source, 'lighter');
    expect(findBoxArena(bg.image, { widthCm: 40, heightCm: 40 }).confidence).toBeLessThan(0.6);
    const fit = findBoxArena(bg.image, { widthCm: 40, heightCm: 40, floor: 'dark' });
    expect(fit.confidence).toBeGreaterThan(0.6);
    expect(invertGray(invertGray(bg.image)).data).toEqual(bg.image.data);
  });

  it('tracks a light mouse in the Barnes pipeline when animalContrast is lighter', async () => {
    const geom = makeGeometry();
    const roundArena = {
      boundary: { kind: 'circle' as const, center: { x: 0, y: 0 }, radius: geom.platformDiameterCm / 2 },
      calibration: { kind: 'scale' as const, pxPerCm: (geom.platformRadiusPx * 2) / geom.platformDiameterCm, originPx: geom.center },
      zones: [],
    };
    const barnesWalk = new PathBuilder({ x: 0, y: 0 }).to({ x: 25, y: 0 }, 2).to({ x: 0, y: 25 }, 2).points;
    const source = arenaRecording(roundArena, 640, 480, barnesWalk, LIGHT_MOUSE);
    const outcome = await barnesMaze.analyze(source, {
      params: DEFAULT_PARAMS,
      geometry: geom,
      animalContrast: 'lighter',
    });
    expect(outcome.track.quality.measuredPositionFraction).toBeGreaterThan(0.9);
  });
});
