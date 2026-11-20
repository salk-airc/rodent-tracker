/** Detect trial start from a cylinder lift or an animal entering an empty maze. */

import type { MazeGeometry, TrackObservation, TrackingParams, TrialStart } from '../types';
import { holeNumber, nearestHole } from '../types';
import type { Timebase } from '../types';
import { frameEndTime, frameTime } from '../../../time';

/** A pre-trial pattern must last this long to be believed, in seconds. */
const MIN_PRETRIAL_SEC = 0.5;
/** ...and the animal must then be present for this long, so a blip is not a start. */
const MIN_CONFIRM_SEC = 0.3;
/** The start cylinder sits in the middle: within this fraction of the radius. */
const CYLINDER_MAX_RADIAL = 0.35;

export function detectTrialStart(
  observations: ReadonlyArray<TrackObservation>,
  timebase: Timebase,
  params: TrackingParams,
  bodyAreaPx: number,
  geometry?: MazeGeometry,
): TrialStart {
  if (observations.length === 0 || timebase.ptsTicks.length === 0) {
    return { frame: 0, reason: 'fileStart', provenance: 'auto', evidence: 'No frames were analyzed.' };
  }

  const secondsAt = (frame: number) => frameTime(timebase, Math.min(frame, timebase.ptsTicks.length - 1));
  const t0 = secondsAt(observations[0]!.frame);
  const isAnimal = (o: TrackObservation) =>
    o.areaPx > 0 && o.areaPx <= bodyAreaPx * params.maxAreaRatio;
  const isCylinder = (o: TrackObservation) =>
    o.areaPx > bodyAreaPx * params.maxAreaRatio && radialFraction(o, geometry) < CYLINDER_MAX_RADIAL;

  // Pattern A: a large static object in the middle, which then goes away.
  let cylinderRun = 0;
  while (cylinderRun < observations.length && isCylinder(observations[cylinderRun]!)) cylinderRun++;
  const cylinderSec = cylinderRun < observations.length
    ? secondsAt(observations[cylinderRun]!.frame) - t0
    : 0;
  if (
    cylinderSec + Number.EPSILON >= MIN_PRETRIAL_SEC &&
    confirmedAfter(observations, cylinderRun, MIN_CONFIRM_SEC, timebase, isAnimal)
  ) {
    const frame = observations[cylinderRun]!.frame;
    const area = observations[0]!.areaPx;
    return {
      frame,
      reason: 'cylinderLift',
      provenance: 'auto',
      evidence:
        `Trial start: frame ${frame}. A central ${Math.round(area)} px object disappeared after ${cylinderSec.toFixed(2)} s ` +
        `(${(area / bodyAreaPx).toFixed(1)} times normal animal area).`,
    };
  }

  // Pattern B: an empty platform that gains an animal.
  let emptyRun = 0;
  while (emptyRun < observations.length && observations[emptyRun]!.areaPx === 0) emptyRun++;
  const emptySec = emptyRun < observations.length
    ? secondsAt(observations[emptyRun]!.frame) - t0
    : 0;
  if (
    emptySec + Number.EPSILON >= MIN_PRETRIAL_SEC &&
    confirmedAfter(observations, emptyRun, MIN_CONFIRM_SEC, timebase, isAnimal)
  ) {
    const frame = observations[emptyRun]!.frame;
    const o = observations[emptyRun]!;
    const where =
      radialFraction(o, geometry) < CYLINDER_MAX_RADIAL
        ? 'near the center of the platform'
        : `near ${holeName(o, geometry)} at the rim`;
    return {
      frame,
      reason: 'animalAppeared',
      provenance: 'auto',
      evidence:
        `Trial start: frame ${frame}. The animal appeared ${where} after ${emptySec.toFixed(2)} s. ` +
        'Confirm this marker if the protocol requires a center release.',
    };
  }

  return {
    frame: observations[0]!.frame,
    reason: 'fileStart',
    provenance: 'auto',
    evidence:
      'No start transition detected. Latency starts at frame 0. Confirm or move this marker.',
  };
}

function radialFraction(observation: TrackObservation, geometry?: MazeGeometry): number {
  if (!geometry || !observation.body || geometry.platformRadiusPx <= 0) return observation.radialFraction;
  return Math.hypot(
    observation.body.x - geometry.center.x,
    observation.body.y - geometry.center.y,
  ) / geometry.platformRadiusPx;
}

/** The lab's number for the hole nearest the animal; without a maze there is no number to give. */
function holeName(observation: TrackObservation, geometry?: MazeGeometry): string {
  const point = observation.nose ?? observation.body;
  const near = geometry && point ? nearestHole(geometry, point) : null;
  return geometry && near ? `hole ${holeNumber(geometry, near.hole.index)}` : 'a hole';
}

function confirmedAfter(
  observations: ReadonlyArray<TrackObservation>,
  from: number,
  needSec: number,
  timebase: Timebase,
  isAnimal: (o: TrackObservation) => boolean,
): boolean {
  if (from >= observations.length) return false;
  const startSec = frameTime(timebase, observations[from]!.frame);
  const windowEndSec = startSec + needSec * 3;
  let observedAnimalSec = 0;
  for (let i = from; i < observations.length; i++) {
    const frame = observations[i]!.frame;
    const frameStartSec = frameTime(timebase, frame);
    if (frameStartSec > windowEndSec) break;
    if (isAnimal(observations[i]!)) {
      observedAnimalSec += Math.max(
        0,
        Math.min(frameEndTime(timebase, frame), windowEndSec) - frameStartSec,
      );
    }
  }
  return observedAnimalSec + Number.EPSILON >= needSec;
}
