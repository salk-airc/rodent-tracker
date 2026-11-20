import type { MazeGeometry } from '../types';

/** Pixels within the platform, with a small margin so a rim-hugging animal is not clipped. */
export function buildPlatformMask(geometry: MazeGeometry, width: number, height: number, margin = 1.02): Uint8Array {
  const mask = new Uint8Array(width * height);
  const r2 = (geometry.platformRadiusPx * margin) ** 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - geometry.center.x;
      const dy = y - geometry.center.y;
      if (dx * dx + dy * dy <= r2) mask[y * width + x] = 1;
    }
  }
  return mask;
}
