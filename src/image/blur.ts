/** Separable Gaussian blur of an 8-bit gray frame into floats, edges clamped. */

export function gaussianKernel(sigma: number): Float32Array {
  if (!(sigma > 0)) return Float32Array.of(1);
  const radius = Math.ceil(3 * sigma);
  const k = new Float32Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) sum += k[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  return k;
}

/**
 * Blur `src` (width × height) into `out`, reusing `scratch` for the horizontal
 * pass. Both buffers are `width * height` long; pass them in to avoid
 * allocating per frame.
 */
export function blurGray(
  src: ArrayLike<number>,
  width: number,
  height: number,
  kernel: Float32Array,
  out: Float32Array = new Float32Array(width * height),
  scratch: Float32Array = new Float32Array(width * height),
): Float32Array {
  const r = (kernel.length - 1) / 2;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i < 0 ? 0 : x + i >= width ? width - 1 : x + i;
        acc += kernel[i + r]! * src[row + xx]!;
      }
      scratch[row + x] = acc;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i < 0 ? 0 : y + i >= height ? height - 1 : y + i;
        acc += kernel[i + r]! * scratch[yy * width + x]!;
      }
      out[y * width + x] = acc;
    }
  }
  return out;
}
