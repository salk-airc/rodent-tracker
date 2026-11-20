/** Small typed-array image operations used by the tracking pipeline. */

export interface Gray {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface FloatImage {
  readonly data: Float32Array;
  readonly width: number;
  readonly height: number;
}

// ---------------------------------------------------------------------------
// Thresholding
// ---------------------------------------------------------------------------

/**
 * Otsu's threshold: the gray level that best separates the histogram into two
 * classes. Used to find the bright platform against the dark surround, which
 * is a genuinely bimodal problem, so Otsu is the right tool rather than a
 * tuned constant that would break on the next rig.
 */
export function otsuThreshold(img: Gray): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < img.data.length; i++) {
    const v = img.data[i]!;
    hist[v] = hist[v]! + 1;
  }
  const total = img.data.length;
  let sumAll = 0;
  for (let v = 0; v < 256; v++) sumAll += v * hist[v]!;

  let wB = 0;
  let sumB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Connected components
// ---------------------------------------------------------------------------

export interface Component {
  readonly label: number;
  readonly areaPx: number;
  /** Sum of x and y over the component, for a centroid if one is wanted. */
  readonly sumX: number;
  readonly sumY: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface ComponentResult {
  /** Label per pixel; 0 means background. */
  readonly labels: Int32Array;
  readonly components: ReadonlyArray<Component>;
}

/**
 * 8-connected labeling with an explicit stack, over an optional sub-window.
 *
 * The window matters for speed: once the animal has been found in frame N, the
 * search in frame N+1 is a box around it rather than the whole platform, which
 * is most of why this runs in well under a millisecond per frame.
 */
export function connectedComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  opts: { minAreaPx?: number; window?: { x0: number; y0: number; x1: number; y1: number } } = {},
): ComponentResult {
  const minArea = opts.minAreaPx ?? 1;
  const x0 = Math.max(0, opts.window?.x0 ?? 0);
  const y0 = Math.max(0, opts.window?.y0 ?? 0);
  const x1 = Math.min(width - 1, opts.window?.x1 ?? width - 1);
  const y1 = Math.min(height - 1, opts.window?.y1 ?? height - 1);

  const labels = new Int32Array(width * height);
  const components: Component[] = [];
  const stack = new Int32Array(Math.max(64, (x1 - x0 + 1) * (y1 - y0 + 1)));
  let nextLabel = 0;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const seed = y * width + x;
      if (!mask[seed] || labels[seed] !== 0) continue;
      nextLabel++;
      let sp = 0;
      stack[sp++] = seed;
      labels[seed] = nextLabel;
      let area = 0;
      let sumX = 0;
      let sumY = 0;
      let bx0 = x;
      let by0 = y;
      let bx1 = x;
      let by1 = y;

      while (sp > 0) {
        const p = stack[--sp]!;
        const py = (p / width) | 0;
        const px = p - py * width;
        area++;
        sumX += px;
        sumY += py;
        if (px < bx0) bx0 = px;
        if (px > bx1) bx1 = px;
        if (py < by0) by0 = py;
        if (py > by1) by1 = py;

        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy;
          if (ny < y0 || ny > y1) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = px + dx;
            if (nx < x0 || nx > x1) continue;
            const q = ny * width + nx;
            if (mask[q] && labels[q] === 0) {
              labels[q] = nextLabel;
              stack[sp++] = q;
            }
          }
        }
      }

      if (area >= minArea) {
        components.push({
          label: nextLabel,
          areaPx: area,
          sumX,
          sumY,
          minX: bx0,
          minY: by0,
          maxX: bx1,
          maxY: by1,
        });
      }
    }
  }

  return { labels, components };
}

export function largestComponent(r: ComponentResult): Component | null {
  let best: Component | null = null;
  for (const c of r.components) if (!best || c.areaPx > best.areaPx) best = c;
  return best;
}

// ---------------------------------------------------------------------------
// Distance transform
// ---------------------------------------------------------------------------

/**
 * Two-pass 3x3 chamfer distance to the nearest background pixel.
 *
 * Approximate (about 2% high on diagonals) and that is fine: we use it to find
 * the thickest part of the animal and to strip the tail, both of which care
 * about relative thickness, not absolute millimeters.
 */
export function chamferDistance(
  mask: Uint8Array,
  width: number,
  height: number,
  window?: { x0: number; y0: number; x1: number; y1: number },
): FloatImage {
  const D = 1;
  const D2 = Math.SQRT2;
  const x0 = Math.max(0, window?.x0 ?? 0);
  const y0 = Math.max(0, window?.y0 ?? 0);
  const x1 = Math.min(width - 1, window?.x1 ?? width - 1);
  const y1 = Math.min(height - 1, window?.y1 ?? height - 1);

  const out = new Float32Array(width * height);
  const BIG = 1e9;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * width + x;
      out[i] = mask[i] ? BIG : 0;
    }
  }

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * width + x;
      if (out[i] === 0) continue;
      let v = out[i]!;
      if (y > y0) {
        v = Math.min(v, out[i - width]! + D);
        if (x > x0) v = Math.min(v, out[i - width - 1]! + D2);
        if (x < x1) v = Math.min(v, out[i - width + 1]! + D2);
      }
      if (x > x0) v = Math.min(v, out[i - 1]! + D);
      out[i] = v;
    }
  }
  for (let y = y1; y >= y0; y--) {
    for (let x = x1; x >= x0; x--) {
      const i = y * width + x;
      if (out[i] === 0) continue;
      let v = out[i]!;
      if (y < y1) {
        v = Math.min(v, out[i + width]! + D);
        if (x < x1) v = Math.min(v, out[i + width + 1]! + D2);
        if (x > x0) v = Math.min(v, out[i + width - 1]! + D2);
      }
      if (x < x1) v = Math.min(v, out[i + 1]! + D);
      out[i] = v;
    }
  }
  return { data: out, width, height };
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/** Bilinear sample, clamped at the edges. */
export function sampleBilinear(img: Gray | FloatImage, x: number, y: number): number {
  const w = img.width;
  const h = img.height;
  const cx = Math.min(Math.max(x, 0), w - 1.001);
  const cy = Math.min(Math.max(y, 0), h - 1.001);
  const ix = Math.floor(cx);
  const iy = Math.floor(cy);
  const fx = cx - ix;
  const fy = cy - iy;
  const i = iy * w + ix;
  const a = img.data[i]!;
  const b = img.data[i + 1]!;
  const c = img.data[i + w]!;
  const d = img.data[i + w + 1]!;
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}
