/**
 * The empty-platform reference image.
 */

import type { FrameSource } from '../types';
import type { Gray } from './imageOps';

export interface BackgroundResult {
  readonly image: Gray;
  readonly sampledFrames: ReadonlyArray<number>;
  readonly percentile: number;
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Per-pixel high percentile over frames spread across the recording.
 *
 * A percentile rather than a mean, because the animal must not be allowed to
 * smear into the reference. The 80th rather than the 50th for a specific
 * reason: the animal is *darker* than the platform, so biasing bright keeps
 * the reference clean even when the animal sits still for a long stretch — and
 * it does. In `test53` the mouse is parked at one hole for the last quarter of
 * the recording; a median over a longer such stay would quietly bake the mouse
 * into the background and then fail to detect it there.
 *
 * Not the per-pixel maximum, which would be immune to that but would also
 * latch onto compression noise and specular flicker, biasing the reference
 * several gray levels bright and turning the detector trigger-happy.
 *
 * This also gives us the geometry for free: an animal-free image is exactly
 * what the platform and ring fits want, so they run on this rather than on an
 * arbitrary frame that has a mouse sitting on a hole.
 */
export async function buildBackground(
  source: FrameSource,
  sampleCount = 41,
  percentile = 0.8,
  onProgress?: (done: number, total: number) => void,
): Promise<BackgroundResult> {
  const n = Math.max(3, Math.min(sampleCount, source.frameCount));
  const wanted = new Set<number>();
  for (let i = 0; i < n; i++) {
    wanted.add(Math.min(source.frameCount - 1, Math.round((i * (source.frameCount - 1)) / (n - 1))));
  }
  const unique = [...wanted].sort((a, b) => a - b);

  const { width, height } = source;
  const stacks: Uint8Array[] = [];
  // One sequential pass, keeping only the frames we want. Seeking to 41
  // scattered frames costs far more than reading the file straight through.
  await source.scan({ from: 0, to: source.frameCount - 1, only: wanted }, (frame, gray) => {
    if (wanted.has(frame)) stacks.push(Uint8Array.from(gray));
  }, onProgress);

  if (stacks.length === 0) throw new Error('No frames could be read from this video.');

  const k = stacks.length;
  const out = new Uint8Array(width * height);
  const scratch = new Uint8Array(k);
  const rank = Math.min(k - 1, Math.max(0, Math.round(percentile * (k - 1))));

  for (let p = 0; p < out.length; p++) {
    for (let s = 0; s < k; s++) scratch[s] = stacks[s]![p]!;
    // Insertion sort is adequate for a scratch array of about 40 values.
    for (let a = 1; a < k; a++) {
      const v = scratch[a]!;
      let b = a - 1;
      while (b >= 0 && scratch[b]! > v) {
        scratch[b + 1] = scratch[b]!;
        b--;
      }
      scratch[b + 1] = v;
    }
    out[p] = scratch[rank]!;
  }

  const warnings: string[] = [];
  if (k < 10) {
    warnings.push(
      `Only ${k} frames were available for the background reference. ` +
        'Detection will be less reliable on very short recordings.',
    );
  }

  return {
    image: { data: out, width, height },
    sampledFrames: unique,
    percentile,
    warnings,
  };
}
