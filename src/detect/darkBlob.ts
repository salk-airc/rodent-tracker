/**
 * `dark-blob-v1`: Simon Dräger's detector from the Barnes maze app.
 *
 * Foreground is every pixel darker than the background by `darkThreshold`.
 * The animal is the connected component closest to the learned body size,
 * searched near the last position first. The body point is the peak of the
 * distance transform (the thickest part, not the centroid), and the nose is
 * told from the tail by how the two ends taper.
 */

import type { Point } from '../types';
import { buildDarkCutoff, buildFrameMask, detectAnimal, type DetectionContext } from '../tracking/detectAnimal';
import { median } from '../stats';
import type { Detector, DetectorFactory } from './types';

/** How many frames of history feed the direction-of-travel estimate. */
const HEADING_WINDOW = 5;
/** Below this movement the heading is meaningless, so it is not used. */
const HEADING_MIN_PX = 3;

export const darkBlobDetector: DetectorFactory = (setup): Detector => {
  const { width, height, background, arenaMask, params } = setup;
  const darkCutoff = buildDarkCutoff(background, arenaMask, params.darkThreshold, width);
  const maskBuffer = new Uint8Array(width * height);
  const recentBodies: Point[] = [];

  // Body area is learned as we go, from a running median of what has been
  // accepted so far. It starts unknown, which is why the blob chooser falls
  // back to "prefer larger" for the first frames.
  const acceptedAreas: number[] = [];
  let bodyAreaPx: number | null = null;

  return {
    id: 'dark-blob-v1',
    detect(_frame, gray) {
      const previous = recentBodies.length ? recentBodies[recentBodies.length - 1]! : null;
      const ctx: DetectionContext = {
        background,
        params,
        platformMask: arenaMask,
        bodyAreaPx,
        previous,
        heading: estimateHeading(recentBodies),
      };

      const { mask, darkPixelsPx } = buildFrameMask(gray, darkCutoff, maskBuffer);
      const detection = detectAnimal(mask, ctx, width, height);
      // On a miss the position history is kept: the animal is most likely
      // hidden at the last known spot, so the next frame looks there first.
      if (!detection) return { detection: null, darkPixelsPx };

      recentBodies.push(detection.body);
      if (recentBodies.length > HEADING_WINDOW) recentBodies.shift();

      // Only frames that look like a whole animal feed the size estimate. A
      // head-down animal or the start cylinder would both bias it.
      if (bodyAreaPx === null || (detection.areaPx < bodyAreaPx * params.maxAreaRatio && detection.areaPx > bodyAreaPx * 0.5)) {
        acceptedAreas.push(detection.areaPx);
        if (acceptedAreas.length % 16 === 0 || bodyAreaPx === null) bodyAreaPx = median(acceptedAreas);
      }
      return { detection, darkPixelsPx };
    },
  };
};

function estimateHeading(recent: ReadonlyArray<Point>): Point | null {
  if (recent.length < 2) return null;
  const a = recent[0]!;
  const b = recent[recent.length - 1]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < HEADING_MIN_PX) return null;
  return { x: dx / len, y: dy / len };
}
