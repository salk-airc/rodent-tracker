/** Framework-independent data shared by the browser, tools, and MCP server. */

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

/** Where the physical scale came from. A default is a prompt, not evidence. */
export type PlatformDiameterSource = 'default' | 'template' | 'manual';

export interface Hole {
  /**
   * Index around the ring. 0 is the hole nearest the ring's fitted phase
   * offset and indices increase clockwise in image coordinates. Stable within
   * a video; see `MazeGeometry.phaseRad` for how it maps across videos.
   */
  readonly index: number;
  readonly center: Point;
  /** Fitted hole radius in pixels. */
  readonly radiusPx: number;
  readonly provenance: Provenance;
}

/**
 * The maze, as six numbers plus per-hole refinements.
 *
 * A 20-hole maze does not need 20 clicks. Center, platform radius, ring
 * radius, phase and hole count describe the whole ring; the detector recovers
 * all of them from one background image, and the user adjusts the parameters
 * rather than the holes. Individual holes can still be nudged, which is what
 * `Hole.provenance` records.
 */
export interface MazeGeometry {
  readonly center: Point;
  readonly platformRadiusPx: number;
  readonly ringRadiusPx: number;
  /** Angle of hole 0, radians, measured from +x toward +y (image coordinates). */
  readonly phaseRad: number;
  readonly holeCount: number;
  readonly holes: ReadonlyArray<Hole>;
  /** Which hole leads to the escape box. Null until known. */
  readonly targetHoleIndex: number | null;
  /**
   * The lab's own numbering: the index of the hole they call 1, and which way
   * numbers increase as seen in the video. Absent means index 0, clockwise.
   */
  readonly holeOneIndex?: number;
  readonly holeNumbering?: 'clockwise' | 'counterclockwise';
  readonly targetProvenance: Provenance;
  /**
   * Real-world platform diameter. Turns pixels into centimeters; without it
   * path length is in pixels, which is not a unit anyone can publish.
   */
  readonly platformDiameterCm: number;
  /**
   * A detected image cannot reveal centimeters. `default` means the common
   * 91.5 cm value is only prefilled for confirmation and must not enter a
   * reportable result.
   */
  readonly platformDiameterSource: PlatformDiameterSource;
  readonly provenance: Provenance;
  /** Diagnostics from the fit, surfaced in the quality report. */
  readonly fit: GeometryFitReport;
}

export interface GeometryFitReport {
  /** Median absolute deviation of the platform edge from the fitted circle, px. */
  readonly platformResidualPx: number;
  /**
   * Strength of the n-fold angular symmetry used to find the ring, 0..1.
   * Low values mean the hole ring was not confidently located and the user
   * should look at the overlay before trusting anything downstream.
   */
  readonly ringSymmetry: number;
  /** Ring radius as a fraction of platform radius. Sanity-checkable by eye. */
  readonly ringRadiusFraction: number;
  readonly warnings: ReadonlyArray<string>;
}

/** Pixels per centimeter implied by the platform diameter. */
export function pxPerCm(g: MazeGeometry): number {
  return (2 * g.platformRadiusPx) / g.platformDiameterCm;
}

/** The hole closest to a point, and its distance in pixels. Null when the maze has no holes. */
export function nearestHole(g: Pick<MazeGeometry, 'holes'>, point: Point): { hole: Hole; distPx: number } | null {
  let best: Hole | null = null;
  let distPx = Number.POSITIVE_INFINITY;
  for (const hole of g.holes) {
    const d = Math.hypot(point.x - hole.center.x, point.y - hole.center.y);
    if (d < distPx) {
      best = hole;
      distPx = d;
    }
  }
  return best ? { hole: best, distPx } : null;
}

/** Resolve a stable hole index without relying on array order. */
export function holeByIndex(g: MazeGeometry, index: number): Hole | undefined {
  return g.holes.find((hole) => hole.index === index);
}

/** Human-facing hole number in the lab's numbering; internal indices stay zero-based. */
export function holeNumber(
  g: Pick<MazeGeometry, 'holeCount' | 'holeOneIndex' | 'holeNumbering'>,
  index: number,
): number {
  const steps = index - (g.holeOneIndex ?? 0);
  const signed = g.holeNumbering === 'counterclockwise' ? -steps : steps;
  return ((signed % g.holeCount) + g.holeCount) % g.holeCount + 1;
}

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

/** Why a frame has a measured, inferred, or missing position. */
export type FrameStatus =
  /** Before the trial started: platform empty, or the start cylinder still down. */
  | 'preTrial'
  /** A plausible mouse-sized blob was found. */
  | 'tracked'
  /**
   * Blob found but much smaller than this animal's learned size, centered on a
   * hole: the animal is partly down that hole. Position is trustworthy, body
   * axis is not.
   */
  | 'partial'
  /**
   * No blob, and the last confident position was locked onto a hole. Treated
   * as "inside the hole", not as a failure. `holeIndex` says which one.
   */
  | 'inHole'
  /** No usable blob and no hole evidence. */
  | 'lost'
  /** After the animal left the platform for good (escaped, or removed). */
  | 'postTrial';

/**
 * Raw pixel measurements before thresholding, gap filling, or smoothing.
 * Keeping measurement separate from interpretation permits fast parameter
 * updates, compact project files, and independent interpretation tests.
 */
export interface TrackObservation {
  readonly frame: number;
  /**
   * Whether `areaPx` was measured from video pixels. Pose CSVs contain
   * coordinates but no visible-area measurement.
   */
  readonly areaMeasured: boolean;
  /** Area of the chosen blob, px. Zero when nothing passed the noise floor. */
  readonly areaPx: number;
  /**
   * Every dark pixel inside the platform, whatever it belongs to. Diverges
   * from `areaPx` when something large and non-animal is present, which is how
   * the start cylinder announces itself.
   */
  readonly darkPixelsPx: number;
  /** Thickest-point center of the blob. */
  readonly body: Point | null;
  /** Blob extremity on the head side of the body axis. */
  readonly nose: Point | null;
  /** Blob extremity on the tail side. Kept because it is the check on the nose. */
  readonly tail: Point | null;
  /** Half-width of the animal at its thickest, px. */
  readonly thicknessPx: number;
  /** Distance from body center to nose, px. */
  readonly noseArmPx: number;
  /** Distance from body center to tail tip, px. Normally two to four times the nose arm. */
  readonly tailArmPx: number;
  /** Hole whose center is nearest the nose, and how far away it is. */
  readonly nearestHole: number;
  readonly nearestHoleDistPx: number;
  /** Blob center's distance from the platform center, as a fraction of the radius. */
  readonly radialFraction: number;
  /** Blobs that passed the noise floor. More than one means the frame is ambiguous. */
  readonly candidateCount: number;
  /** True when the animal had to be found by searching the whole platform. */
  readonly reacquired: boolean;
  /**
   * How clearly the head end could be told from the tail end, 0..1. Low when
   * the animal is curled up or its tail is folded alongside its body, in which
   * case the nose is a guess and any measure that depends on it should say so.
   */
  readonly axisConfidence: number;
}

export interface TrackFrame {
  readonly frame: number;
  readonly status: FrameStatus;
  /**
   * Body center: the peak of the distance transform of the blob, i.e. the
   * thickest part of the animal. Deliberately not the centroid of dark pixels,
   * which the tail drags several centimeters off the animal.
   */
  readonly body: Point | null;
  /**
   * Nose: the blob extremity along the body axis, on the side away from the
   * tail. "Did it poke its nose in the hole" is a question about this point,
   * not about the body.
   */
  readonly nose: Point | null;
  /** Visible blob area in pixels. The escape signal is a collapse in this. */
  readonly areaPx: number;
  /** False when the source supplied coordinates but no visible-area measurement. */
  readonly areaMeasured: boolean;
  /** Which hole explains this frame, for `partial` and `inHole`. */
  readonly holeIndex: number | null;
  /** 0..1. Low confidence is surfaced, never silently smoothed away. */
  readonly confidence: number;
  /**
   * True when this position was filled in across a gap rather than measured.
   *
   * Kept as its own flag rather than folded into the status, because the plots
   * draw interpolated stretches differently and the quality report counts them
   * separately. This prevents filled gaps from appearing measured.
   */
  readonly interpolated: boolean;
  /** Provenance of the categorical label and any hole assignment. */
  readonly statusProvenance: MeasurementProvenance;
  /** Provenance of each point, kept separate because edits are field-specific. */
  readonly bodyProvenance: MeasurementProvenance;
  readonly noseProvenance: MeasurementProvenance;
  /** Summary provenance: manual when any field on this frame was edited. */
  readonly provenance: MeasurementProvenance;
}

/** True only for a position measured from a frame or explicitly corrected by a person. */
export function hasMeasuredPosition(
  frame: TrackFrame,
): frame is TrackFrame & { readonly body: NonNullable<TrackFrame['body']> } {
  return (
    frame.body !== null &&
    !frame.interpolated &&
    (frame.status === 'tracked' || frame.status === 'partial')
  );
}

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

/** Pixel-pass settings that cannot be changed without reading the video again. */
export type MeasurementTrackingParams = Pick<
  TrackingParams,
  'darkThreshold' | 'minBlobPx' | 'maxAreaRatio' | 'bodyCoreErodePx' | 'backgroundSampleFrames'
>;

/** What produced the stored per-frame positions. */
export type MeasurementBasis =
  | {
      readonly kind: 'video';
      readonly tracking: MeasurementTrackingParams;
      readonly platform: {
        readonly center: Point;
        readonly radiusPx: number;
      };
    }
  | {
      readonly kind: 'imported-pose';
    };

export interface TrackingQuality {
  readonly frameCount: number;
  readonly trackedFrames: number;
  readonly partialFrames: number;
  readonly inHoleFrames: number;
  readonly lostFrames: number;
  readonly preTrialFrames: number;
  readonly postTrialFrames: number;
  readonly manuallyEditedFrames: number;
  /** In-trial frames backed by a measured or explicitly corrected position. */
  readonly measuredPositionFrames: number;
  readonly measuredPositionFraction: number;
  /**
   * Fraction tracked, partly visible, or explicitly explained as inside a
   * hole. This is broader than measured-position coverage and is retained as a
   * quality-of-interpretation metric, not a trajectory metric.
   */
  readonly trackedFraction: number;
  /** Learned body area for this animal, px. */
  readonly bodyAreaPx: number;
  /** Longest run of `lost` frames, and where it starts. Where to look first. */
  readonly longestGapFrames: number;
  readonly longestGapStart: number | null;
  readonly warnings: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Trial boundaries
// ---------------------------------------------------------------------------

/** Trial start detected from video or set manually. */
export interface TrialStart {
  readonly frame: number;
  readonly reason:
    /** A large static blob at the platform center disappeared: cylinder lifted. */
    | 'cylinderLift'
    /** An empty platform gained a mouse-sized blob. */
    | 'animalAppeared'
    /** Nothing detected; the recording appears to start mid-trial. */
    | 'fileStart'
    | 'manual';
  readonly provenance: Provenance;
  /** Human-readable justification shown next to the marker in the UI. */
  readonly evidence: string;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * `investigation` and `entry` are different claims with different evidence.
 *
 * An investigation means the nose stayed near a hole. An entry is an
 * operational detector label: visible body area stayed below a threshold while
 * the track remained associated with one hole. It is kept separate because it
 * needs stronger evidence than proximity alone.
 */
export type EventType = 'investigation' | 'entry';

export interface HoleEvent {
  readonly id: string;
  readonly type: EventType;
  readonly holeIndex: number;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly isTarget: boolean;
  /**
   * Whether this investigation counts as an error. False for target visits and
   * for repeat visits when the user is counting unique holes only.
   */
  readonly isError: boolean;
  /** Closest approach of the nose to the hole center during the event, cm. */
  readonly minNoseDistanceCm: number;
  /** Smallest visible area during the event as a fraction of body area. */
  readonly minAreaRatio: number;
  readonly provenance: MeasurementProvenance;
  /** Plain-English reason this event exists, shown in the UI and exported. */
  readonly evidence: string;
}

export interface EventParams {
  /**
   * Nose within this distance of a hole center counts as investigating it.
   * There is no single right answer in the literature, which is exactly why
   * this is a control and not a constant.
   */
  readonly investigationRadiusCm: number;
  /** Minimum dwell for an investigation, seconds. Rejects fly-pasts. */
  readonly minInvestigationSec: number;
  /** Two visits to the same hole separated by less than this merge into one. */
  readonly mergeGapSec: number;
  /**
   * The nose must move out to this multiple of the investigation radius before
   * a visit is considered over.
   *
   * Without hysteresis the visits fragment badly, and not for a subtle reason:
   * an animal parked at a hole holds its nose 2 to 3 cm from the center, which
   * is right on top of the 3 cm threshold. Sub-pixel jitter then flickers it in
   * and out, and one long investigation is reported as six. Measured on
   * `test51`, hole 18 at the end of the trial.
   */
  readonly exitRadiusMultiple: number;
  /**
   * Visible area must fall below this fraction of body area to call an entry.
   */
  readonly entryAreaRatio: number;
  /** ...and stay there for at least this long, seconds. */
  readonly minEntrySec: number;
  /** Count each hole once (`unique`) or every visit (`all`) when tallying errors. */
  readonly errorCounting: 'unique' | 'all';
  /**
   * Whether investigating a hole adjacent to the target counts as an error.
   * Some labs treat the two neighbors as near-misses; ours defaults to
   * counting them, and says so.
   */
  readonly adjacentHolesAreErrors: boolean;
}

// ---------------------------------------------------------------------------
// Search strategy
// ---------------------------------------------------------------------------

export type SearchStrategy = 'spatial' | 'serial' | 'random' | 'unclassified';

/**
 * The features the classification is made from, kept alongside the label.
 *
 * Strategy is the most sensitive readout in the assay and the one most often
 * scored by eye. A bare label is not defensible, so the rule that fired and
 * the numbers it fired on travel with it, and the user can override the label
 * without losing the evidence.
 */
export interface StrategyFeatures {
  /** Straight-line distance from start to target, divided by path length. 1 = perfect. */
  readonly pathEfficiency: number;
  /** Share of possible pre-target frame-to-frame steps backed by measured positions. */
  readonly pathCoverage: number;
  /** Distinct holes investigated before the first target visit. */
  readonly holesBeforeTarget: number;
  /** Longest run of consecutively-numbered holes visited in one direction. */
  readonly longestSerialRun: number;
  /** Times the animal crossed the central zone after leaving it. */
  readonly centerCrossings: number;
  /** Fraction of in-trial time spent outside 0.7 of the platform radius. */
  readonly peripheryFraction: number;
  /** Mean absolute change in heading per second, deg/s. High = unsystematic. */
  readonly meanTurnRateDegPerSec: number;
  /**
   * How far the animal was from the target when the trial started, cm.
   *
   * Reported because it decides whether `pathEfficiency` means anything. An
   * animal released a hole away from the target reaches it efficiently whatever
   * it knows, so that route cannot support a spatial classification.
   */
  readonly startDistanceCm: number;
}

export interface StrategyResult {
  readonly strategy: SearchStrategy;
  readonly features: StrategyFeatures;
  /** Which rule fired, in the order they were tested. */
  readonly rule: string;
  readonly provenance: Provenance;
  readonly notes: string;
}

export interface StrategyParams {
  readonly spatialMinEfficiency: number;
  readonly spatialMaxHolesBeforeTarget: number;
  readonly serialMinRun: number;
  readonly serialMinPeripheryFraction: number;
  readonly randomMinCenterCrossings: number;
}

// ---------------------------------------------------------------------------
// Measures
// ---------------------------------------------------------------------------

/**
 * A latency that may not have happened.
 *
 * When an event is not detected before the protocol or recording endpoint, its
 * latency is stored as a flagged lower bound rather than a made-up event time.
 */
export interface Latency {
  /** Seconds from trial start, or the endpoint if the event was not detected. */
  readonly sec: number;
  /** False when the event was not detected and `sec` is a lower bound. */
  readonly observed: boolean;
  /** Frame the event was measured at, for "go find the frame this came from". */
  readonly frame: number | null;
  readonly provenance: LatencyProvenance;
}

export interface TrialMeasures {
  readonly videoId: string;
  /** Time until the nose first reached the target hole. */
  readonly primaryLatency: Latency;
  /** Time until the first target entry event. */
  readonly totalLatency: Latency;
  /** Non-target investigations before the first target visit. */
  readonly primaryErrors: number;
  /** Fraction of frames before the target visit that could support a hole visit. */
  readonly primaryErrorCoverage: number;
  /** Non-target investigations over the whole trial. */
  readonly totalErrors: number;
  /** Fraction of the scored trial that could support a hole visit. */
  readonly totalErrorCoverage: number;
  readonly pathLengthCm: number;
  readonly meanSpeedCmPerSec: number;
  /** Speed while moving, excluding pauses. Reported separately because a long freeze halves the mean. */
  readonly meanMovingSpeedCmPerSec: number;
  readonly maxSpeedCmPerSec: number;
  readonly timeInTargetQuadrantSec: number;
  readonly targetQuadrantFraction: number;
  /** Fraction of in-trial time with a measured position for the quadrant result. */
  readonly targetQuadrantCoverage: number;
  readonly trialDurationSec: number;
  readonly strategy: StrategyResult;
  readonly quality: TrackingQuality;
  /** Path length is only meaningful over frames we actually tracked. */
  readonly pathLengthCoverage: number;
  readonly warnings: ReadonlyArray<string>;
}

/** Everything needed to reproduce a number, traveling with the number. */
export interface AnalysisParams {
  readonly tracking: TrackingParams;
  readonly events: EventParams;
  readonly strategy: StrategyParams;
  /** Trial cutoff, seconds. Events and measures stop here; unobserved latencies are censored. */
  readonly trialCutoffSec: number;
  /** Radius of the central zone, as a fraction of platform radius. */
  readonly centerZoneFraction: number;
  /** Speed below this counts as not moving, cm/s. */
  readonly movingSpeedThresholdCmPerSec: number;
  /** Gaps up to this many frames may be interpolated; longer gaps stay gaps. */
  readonly maxInterpolateGapFrames: number;
  /** Median filter window for the trajectory, in frames. 1 disables it. */
  readonly smoothingWindowFrames: number;
  /**
   * Window over which speed is measured, seconds.
   *
   * Speed is not computed between adjacent frames, because these files contain
   * timestamp intervals of a single tick — 0.067 ms, a 15,000 fps equivalent —
   * left behind by the re-encode. A real 0.6 cm step across one of those comes
   * out at 8,775 cm/s. Measuring displacement across a fixed span of time
   * instead is immune to that, and is a more meaningful quantity for an animal
   * anyway.
   */
  readonly speedWindowSec: number;
}
