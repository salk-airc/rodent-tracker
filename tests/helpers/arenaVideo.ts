import { arenaMask, type Arena } from '../../src/arena/arena';
import { toImage } from '../../src/arena/calibration';
import type { FrameSource, Point } from '../../src/types';
import { makeTimebase } from './synthetic';

const FLOOR = 200;
const OFF_ARENA = 30;
const MOUSE = 40;

/**
 * A synthetic overhead recording of `arena`: a light floor inside the
 * boundary, dark outside, and a dark mouse (body ellipse and tail) at each
 * path point in world cm, facing the way it is walking. Null hides the mouse.
 */
export function arenaRecording(arena: Arena, width: number, height: number, path: ReadonlyArray<Point | null>): FrameSource {
  const mask = arenaMask(arena, width, height);
  const timebase = makeTimebase(path.length);
  let heading = 0;
  const headings = path.map((p, i) => {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(path.length - 1, i + 1)];
    if (p && a && b) {
      const pa = toImage(arena.calibration, a);
      const pb = toImage(arena.calibration, b);
      if (Math.hypot(pb.x - pa.x, pb.y - pa.y) > 0.05) heading = Math.atan2(pb.y - pa.y, pb.x - pa.x);
    }
    return heading;
  });
  const draw = (frame: number): Uint8Array => {
    const gray = new Uint8Array(width * height);
    for (let i = 0; i < gray.length; i++) gray[i] = mask[i] ? FLOOR : OFF_ARENA;
    const at = path[frame];
    if (!at) return gray;
    const c = toImage(arena.calibration, at);
    const cos = Math.cos(headings[frame]!);
    const sin = Math.sin(headings[frame]!);
    for (let y = Math.floor(c.y - 32); y <= c.y + 32; y++) {
      for (let x = Math.floor(c.x - 32); x <= c.x + 32; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        // Mouse-frame coordinates: u forward, v sideways.
        const u = (x - c.x) * cos + (y - c.y) * sin;
        const v = -(x - c.x) * sin + (y - c.y) * cos;
        const inBody = (u / 14) ** 2 + (v / 7) ** 2 <= 1;
        const inTail = Math.abs(v) <= 0.6 && u < -12 && u >= -28;
        if (inBody || inTail) gray[y * width + x] = MOUSE;
      }
    }
    return gray;
  };
  return {
    width,
    height,
    frameCount: path.length,
    timebase,
    getGrayFrame: async (frame) => draw(frame),
    async scan(range, visit, onProgress) {
      for (let f = range.from; f <= range.to; f++) {
        await visit(f, draw(f));
        onProgress?.(f - range.from + 1, range.to - range.from + 1);
      }
    },
    close() {},
  };
}

/** Builds a path at 30 fps from moves and pauses, in world cm. */
export class PathBuilder {
  readonly points: Point[] = [];
  constructor(private at: Point) {}
  /** Walk in a straight line to `to` over `seconds`. */
  to(to: Point, seconds: number): this {
    const n = Math.round(seconds * 30);
    for (let i = 0; i < n; i++) {
      this.points.push({ x: this.at.x + ((to.x - this.at.x) * i) / n, y: this.at.y + ((to.y - this.at.y) * i) / n });
    }
    this.at = to;
    return this;
  }
  /** Stand still for `seconds`, with a slight sway so the animal is not frozen into the background. */
  stay(seconds: number): this {
    const n = Math.round(seconds * 30);
    for (let i = 0; i < n; i++) this.points.push({ x: this.at.x + 0.3 * Math.sin(i / 3), y: this.at.y });
    return this;
  }
}
