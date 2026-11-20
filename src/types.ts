/** Paradigm-independent types: time, frame access, points, provenance, detector settings. */

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * Per-frame presentation timestamps from the container.
 *
 * Time is never computed as `frameIndex / fps`. The sample clips are not
 * constant frame rate: `test51` runs at 15000/1001 fps, and all three carry
 * re-encode artifacts where some frames share a timestamp with their
 * neighbor and some intervals are twice the nominal one. Frame index is used
 * for seeking; reported times use `ptsTicks`.
 */
export interface Timebase {
  /** Ticks per second (the mp4 track timescale, e.g. 15360 or 15000). */
  readonly timescale: number;
  /** Presentation timestamp of each frame, in ticks, in presentation order. */
  readonly ptsTicks: ReadonlyArray<number>;
}

/** Seconds from the start of the file for a given frame index. */
export function frameTime(tb: Timebase, frame: number): number {
  const t = tb.ptsTicks[frame];
  if (t === undefined) throw new RangeError(`frame ${frame} out of range`);
  return t / tb.timescale;
}

/** Container timing diagnostics for the quality report. */
export interface TimingReport {
  readonly timescale: number;
  readonly frameCount: number;
  /** Most common inter-frame interval, in ticks. */
  readonly nominalDeltaTicks: number;
  /** Nominal frame rate implied by that interval. */
  readonly nominalFps: number;
  /** frameCount / duration, which differs from nominalFps when frames are held or dropped. */
  readonly effectiveFps: number;
  readonly durationSec: number;
  /** Frames whose timestamp equals the previous frame's. Timing here is ±1 frame. */
  readonly duplicateTimestampFrames: ReadonlyArray<number>;
  /** Frames preceded by a gap that is not the nominal interval. */
  readonly irregularIntervalFrames: ReadonlyArray<number>;
}

// ---------------------------------------------------------------------------
// Frame access
// ---------------------------------------------------------------------------

/**
 * A random-access source of grayscale frames.
 *
 * Implemented by WebCodecs in the browser and ffmpeg in the regression tools.
 * Both feed the same analysis code.
 */
export interface FrameSource {
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly timebase: Timebase;
  /**
   * Single-channel 8-bit luminance, `width * height` bytes, row-major.
   *
   * The source is a grayscale camera, so the color channels carry no
   * information and we drop them at decode.
   *
   * Use {@link FrameSource.scan} for full-video passes. Random access is more
   * expensive in the ffmpeg regression harness.
   */
  getGrayFrame(frame: number): Promise<Uint8Array>;

  /**
   * Visit a range of frames in order.
   *
   * Background estimation and tracking use sequential scans, which are faster
   * than repeated seeks in both frame-source implementations.
   *
   * The buffer handed to `visit` is reused between calls: copy it if you intend
   * to keep it.
   *
   * `only`, when given, names the frames the caller needs. A source may then
   * skip reading the others' pixels, but may still visit them.
   */
  scan(
    range: { readonly from: number; readonly to: number; readonly only?: ReadonlySet<number> },
    visit: (frame: number, gray: Uint8Array) => void | Promise<void>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void>;

  close(): void;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Did a value come from the detector, a saved template, or a person? */
export type Provenance = 'auto' | 'template' | 'manual';

/** Source of a measured position or event; imported pose is not native tracking. */
export type MeasurementProvenance = 'auto' | 'imported' | 'manual';

/** A latency can also be an explicit protocol/recording lower bound. */
export type LatencyProvenance = MeasurementProvenance | 'censored_cutoff';

/** Per-recording source of the stored position observations. */
export type TrackingSource = 'video' | 'deeplabcut' | 'sleap-analysis-csv';

// ---------------------------------------------------------------------------
// Detection settings
// ---------------------------------------------------------------------------

export interface TrackingParams {
  /**
   * How much darker than the background a pixel must be to count as animal,
   * in 8-bit levels.
   */
  readonly darkThreshold: number;
  /** Blobs smaller than this are noise, in px. */
  readonly minBlobPx: number;
  /**
   * Reject blobs larger than this multiple of the learned body area. Catches
   * the start cylinder (4.4x body area in `test51`), hands reaching in, and
   * shadows merging with the animal.
   */
  readonly maxAreaRatio: number;
  /**
   * Below this fraction of the learned body area, a blob centered on a hole is
   * `partial` rather than `tracked`.
   */
  readonly partialAreaRatio: number;
  /**
   * Erosion depth used to strip the tail before finding the body axis, in px.
   * The tail is 1-2 px of half-width and the body is about 10, so anything in
   * between works; the default is not delicate.
   */
  readonly bodyCoreErodePx: number;
  /** Frames used to build the median background image. */
  readonly backgroundSampleFrames: number;
  /** A lost blob within this many px of a hole center is `inHole`, not `lost`. */
  readonly holeLockRadiusPx: number;
}
