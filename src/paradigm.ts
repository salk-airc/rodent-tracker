/**
 * A paradigm is one behavioral test (Barnes maze, open field, plus maze…):
 * its arena, what it measures, and how it turns detections into results.
 *
 * Every paradigm shares the same engine underneath: background, a detector
 * run once over the video (`detectFrames`), and arenas and zones in world cm.
 * What differs is the geometry it fits and the measures it reports. Apps list
 * paradigms through this interface and run them without knowing their internals.
 */

import type { DetectorFactory } from './detect/types';
import type { FrameSource } from './types';

export interface ParadigmRunOptions {
  /** Which detector finds the animal. Each paradigm has its own default. */
  readonly detector?: DetectorFactory;
  readonly onProgress?: (stage: string, done: number, total: number) => void;
}

export interface Paradigm<Config, Result> {
  /** Stable id, used in project files and URLs, e.g. `barnes-maze`. */
  readonly id: string;
  readonly name: string;
  /** One sentence for a paradigm picker. */
  readonly summary: string;
  /** The headline measures, in the order a report shows them. */
  readonly measures: ReadonlyArray<string>;
  analyze(source: FrameSource, config: Config, options?: ParadigmRunOptions): Promise<Result>;
}
