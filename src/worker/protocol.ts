/**
 * Messages between the interface and the analysis worker.
 *
 * Decoding and tracking both run in the worker, for one plain reason: a
 * three-minute recording takes several seconds of solid CPU, and on the main
 * thread that is several seconds of a frozen window with no progress bar. A
 * scientist watching a frozen tab concludes the tool is broken, and they are
 * not wrong to.
 *
 * The worker also owns the decoder, so there is one decode cache rather than
 * two, and the correction view asks it for individual frames.
 */

import type { AnalysisParams, MazeGeometry, MeasurementBasis, Timebase, TimingReport, TrialStart } from '../types';
import type { RigTemplate } from '../geometry/detect';
import type { PackedObservations } from '../project/schema';
import type { AnalysisStage } from '../pipeline';

export type WorkerRequest =
  | { readonly type: 'open'; readonly videoId: string; readonly file: Blob }
  | {
      readonly type: 'analyze';
      readonly videoId: string;
      readonly params: AnalysisParams;
      readonly template?: RigTemplate;
      readonly geometry?: MazeGeometry;
    }
  | { readonly type: 'frame'; readonly videoId: string; readonly frame: number; readonly requestId: number }
  | { readonly type: 'background'; readonly videoId: string; readonly requestId: number }
  | { readonly type: 'release'; readonly videoId: string }
  | { readonly type: 'close'; readonly videoId: string };

export interface OpenedVideo {
  readonly sourceSha256?: string | null;
  readonly videoId: string;
  readonly fileName: string;
  readonly fileSize: number | null;
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly timebase: Timebase;
  readonly timing: TimingReport;
  /** Median gap between keyframes, or null when a saved project did not retain it. */
  readonly keyframeInterval: number | null;
}

export interface AnalyzedVideo {
  readonly videoId: string;
  /** Saved rig used for scale/target provenance, if any. */
  readonly rigId: string | null;
  readonly geometry: MazeGeometry;
  readonly measurementBasis: MeasurementBasis;
  readonly observations: PackedObservations;
  readonly bodyAreaPx: number;
  readonly bodyAreaSpread: number;
  readonly detectedTrialStart: TrialStart;
  readonly notes: ReadonlyArray<string>;
}

export type WorkerResponse =
  | { readonly type: 'opened'; readonly video: OpenedVideo }
  | {
      readonly type: 'progress';
      readonly videoId: string;
      readonly stage: AnalysisStage;
      readonly done: number;
      readonly total: number;
    }
  | { readonly type: 'analyzed'; readonly result: AnalyzedVideo }
  | {
      readonly type: 'frameData';
      readonly requestId: number;
      readonly videoId: string;
      readonly frame: number;
      readonly gray: Uint8Array;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly type: 'frameFailed';
      readonly requestId: number;
      readonly videoId: string;
      readonly frame: number;
      readonly message: string;
    }
  | {
      readonly type: 'backgroundData';
      readonly requestId: number;
      readonly videoId: string;
      readonly gray: Uint8Array;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly type: 'backgroundFailed';
      readonly requestId: number;
      readonly videoId: string;
      readonly message: string;
    }
  | {
      readonly type: 'failed';
      readonly videoId: string;
      /** Written for the user, not for a log. */
      readonly message: string;
      /** True when the error cannot be retried in the current browser. */
      readonly fatal: boolean;
    };
