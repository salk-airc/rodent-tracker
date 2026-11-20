/** Small numeric helpers shared by core, the tools, and the MCP server. */

/** Middle value, or the mean of the two middle values. NaN when empty. */
export function median(values: ArrayLike<number>): number {
  const a = Array.from(values).sort((p, q) => p - q);
  if (a.length === 0) return Number.NaN;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
}

/** Arithmetic mean. NaN when empty. */
export function mean(values: ReadonlyArray<number>): number {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : Number.NaN;
}

/** Round to a number of decimal places. NaN for a non-finite input. */
export function round(value: number, digits = 3): number {
  if (!Number.isFinite(value)) return Number.NaN;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
