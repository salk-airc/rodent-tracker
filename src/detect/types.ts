/**
 * The detector seam: everything that turns one decoded frame into a position
 * for the animal. The rest of the engine (arena, events, measures, review)
 * only sees `FrameDetection`, so detectors can be swapped and compared on
 * the same video without touching anything downstream.
 */

import type { Gray } from '../image/imageOps';
import type { Point, TrackingParams } from '../types';

/** What a detector is given once per video, before the first frame. */
export interface DetectorSetup {
  readonly width: number;
  readonly height: number;
  /** The empty-arena reference image, same size as a frame. */
  readonly background: Gray;
  /** 1 where the animal can be, 0 elsewhere (rig, cables, the room). */
  readonly arenaMask: Uint8Array;
  /** Already scaled to this video (see `scaleTrackingParams`). */
  readonly params: TrackingParams;
  /**
   * This video's px/cm over the sample clips' (`sizeScaleFor`). When given,
   * detectors also rescale their built-in pixel sizes; when absent they keep
   * the sizes tuned on the sample clips, unchanged.
   */
  readonly sizeScale?: number;
}

/** One frame's answer: where the animal is and how sure the detector is. */
export interface AnimalDetection {
  readonly areaPx: number;
  /** Center of the body, wherever the detector defines it. */
  readonly body: Point;
  readonly nose: Point;
  readonly tail: Point;
  /** Half-width of the animal at its thickest, px. */
  readonly thicknessPx: number;
  readonly noseArmPx: number;
  readonly tailArmPx: number;
  /** How clearly the two ends could be told apart, 0..1. */
  readonly axisConfidence: number;
  /** Blobs (or candidates) that passed the noise floor. More than one is ambiguous. */
  readonly candidateCount: number;
  /** True when the animal had to be found by searching the whole arena. */
  readonly reacquired: boolean;
  /**
   * Why the detector trusts or doubts this frame, in words a reviewer can
   * check against the video, e.g. "selected 1 of 2 similarly plausible
   * foreground components". Optional: not every detector explains itself.
   */
  readonly reason?: string;
}

export interface FrameDetection {
  /** Null when no animal was found in this frame. */
  readonly detection: AnimalDetection | null;
  /** Foreground pixels inside the arena, whatever they belong to. */
  readonly darkPixelsPx: number;
}

/**
 * A detector for one video. Stateful: it may keep the last position, the
 * direction of travel or a learned body size between frames, so frames must
 * be given in order.
 */
export interface Detector {
  /** Stable name recorded with the results, e.g. `dark-blob-v1`. */
  readonly id: string;
  /** `timeS` is the frame's presentation time, for speed limits and gaps. */
  detect(frame: number, gray: Uint8Array, timeS: number): FrameDetection;
  /**
   * Optional second pass over the whole video once every frame is detected,
   * for corrections that need neighbouring frames (e.g. fixing a nose that
   * flipped to the tail for a few frames). Returns one result per frame.
   */
  finish?(detections: ReadonlyArray<FrameDetection>): ReadonlyArray<FrameDetection>;
}

export type DetectorFactory = (setup: DetectorSetup) => Detector;
