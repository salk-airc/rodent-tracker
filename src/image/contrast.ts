/**
 * Animals lighter than their floor, or either way.
 *
 * Every detector looks for an animal darker than the empty-arena background:
 * a black mouse on a white floor. Rather than teach each one the other cases,
 * the frames are transformed so the animal comes out darker whatever it was:
 *
 * - `darker` (default): unchanged.
 * - `lighter`, an albino mouse on a dark floor: the image is inverted.
 * - `either`: each pixel becomes the background minus its distance from the
 *   background, so any change, lighter or darker, reads as darker. Use it for
 *   a mottled animal, or one whose contrast flips across the arena.
 *
 * The background is built to match. The 80th percentile keeps a dark animal
 * that sits still out of the reference (see `background.ts`); a light animal
 * needs the 20th for the same reason, and `either` the median, which a long
 * stay in one spot can still leak into.
 */

import type { FrameSource } from '../types';
import type { Gray } from './imageOps';
import { buildBackground, type BackgroundResult } from './background';

export type AnimalContrast = 'darker' | 'lighter' | 'either';

/** The background percentile that keeps an animal of this contrast out of the reference. */
export function backgroundPercentile(contrast: AnimalContrast): number {
  return contrast === 'darker' ? 0.8 : contrast === 'lighter' ? 0.2 : 0.5;
}

/** The empty-arena background in the recording's own gray levels, for an animal of this contrast. */
export function buildArenaBackground(
  source: FrameSource,
  contrast: AnimalContrast = 'darker',
  sampleCount?: number,
  onProgress?: (done: number, total: number) => void,
): Promise<BackgroundResult> {
  return buildBackground(source, sampleCount, backgroundPercentile(contrast), onProgress);
}

export function invertGray(img: Gray): Gray {
  const data = new Uint8Array(img.data.length);
  for (let i = 0; i < data.length; i++) data[i] = 255 - img.data[i]!;
  return { data, width: img.width, height: img.height };
}

/**
 * The source and background a detector should see: the animal darker than the
 * background. `background` is from `buildArenaBackground` with the same contrast.
 */
export function asDarkerAnimal(
  source: FrameSource,
  background: Gray,
  contrast: AnimalContrast,
): { readonly source: FrameSource; readonly background: Gray } {
  if (contrast === 'darker') return { source, background };
  if (contrast === 'lighter') return { source: mapFrames(source, (v) => 255 - v), background: invertGray(background) };
  const bg = background.data;
  return { source: mapFrames(source, (v, i) => Math.max(0, bg[i]! - Math.abs(v - bg[i]!))), background };
}

/** A source whose frames pass through `f` (value, pixel index). */
function mapFrames(source: FrameSource, f: (value: number, index: number) => number): FrameSource {
  const n = source.width * source.height;
  const out = new Uint8Array(n);
  const apply = (gray: Uint8Array, into: Uint8Array): Uint8Array => {
    for (let i = 0; i < n; i++) into[i] = f(gray[i]!, i);
    return into;
  };
  return {
    width: source.width,
    height: source.height,
    frameCount: source.frameCount,
    timebase: source.timebase,
    getGrayFrame: async (frame) => apply(await source.getGrayFrame(frame), new Uint8Array(n)),
    // The scan buffer is reused between visits, as the FrameSource contract allows.
    scan: (range, visit, onProgress) => source.scan(range, (frame, gray) => visit(frame, apply(gray, out)), onProgress),
    close: () => source.close(),
  };
}
