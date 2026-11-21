/** Arena finders. See `types.ts` for what a finder promises. */

export { CONFIDENT_FIT, noFit, type ArenaFinder, type ArenaFit } from './types';
export { findRoundArena, type RoundArenaOptions } from './round';
export { findBoxArena, type BoxArenaOptions } from './box';
export { fitBrightDisc, robustCircleFit, type DiscFit } from './disc';
