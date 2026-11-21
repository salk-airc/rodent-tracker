/**
 * Arena finders: from an image of the empty apparatus (the background) and its
 * real dimensions, where the arena is and how pixels map to centimeters.
 *
 * A finder proposes; a person confirms. Every fit carries a confidence and
 * the reasons to doubt it, so an app can show the proposal for confirmation
 * and fall back to placing the arena by hand when the finder is unsure.
 */

import type { Arena } from '../arena';
import type { Correspondence } from '../calibration';
import type { Gray } from '../../image/imageOps';

export interface ArenaFit {
  /** The placed arena, or null when nothing usable was found. */
  readonly arena: Arena | null;
  /** 0 (nothing found) to 1 (a clean fit). Below about 0.6, ask a person to place it. */
  readonly confidence: number;
  /** The image points the fit rests on and the world points they were matched to, for display and checking. */
  readonly landmarks: ReadonlyArray<Correspondence>;
  readonly warnings: ReadonlyArray<string>;
}

export type ArenaFinder<Options> = (background: Gray, options: Options) => ArenaFit;

/** Below this confidence a finder's proposal should be checked by hand. */
export const CONFIDENT_FIT = 0.6;

export function noFit(why: string): ArenaFit {
  return { arena: null, confidence: 0, landmarks: [], warnings: [why] };
}
