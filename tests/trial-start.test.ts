import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS } from '../src/paradigms/barnes/params';
import { detectTrialStart } from '../src/paradigms/barnes/tracking/trialStart';
import type { TrackObservation, Timebase } from '../src/paradigms/barnes/types';
import { BODY_AREA_PX } from './helpers/synthetic';


function observation(frame: number, areaPx: number, radialFraction = 0.1): TrackObservation {
  const present = areaPx > 0;
  return {
    frame,
    areaMeasured: true,
    areaPx,
    darkPixelsPx: areaPx,
    body: present ? { x: 320, y: 240 } : null,
    nose: present ? { x: 325, y: 240 } : null,
    tail: present ? { x: 315, y: 240 } : null,
    thicknessPx: present ? 8 : 0,
    noseArmPx: present ? 5 : 0,
    tailArmPx: present ? 5 : 0,
    nearestHole: 0,
    nearestHoleDistPx: 180,
    radialFraction,
    candidateCount: present ? 1 : 0,
    reacquired: false,
    axisConfidence: present ? 1 : 0,
  };
}

function detect(areas: number[], ptsTicks: number[]) {
  const timebase: Timebase = { timescale: 1000, ptsTicks };
  return detectTrialStart(
    areas.map((area, frame) => observation(frame, area)),
    timebase,
    DEFAULT_PARAMS.tracking,
    BODY_AREA_PX,
  );
}

describe('trial-start timing', () => {
  it('accepts a short frame run when timestamps show a long enough cylinder period', () => {
    const result = detect(
      [BODY_AREA_PX * 5, BODY_AREA_PX * 5, BODY_AREA_PX * 5, BODY_AREA_PX, BODY_AREA_PX, BODY_AREA_PX],
      [0, 100, 200, 600, 700, 1000],
    );
    expect(result).toMatchObject({ reason: 'cylinderLift', frame: 3 });
  });

  it('rejects a long frame run when timestamps show too little elapsed time', () => {
    const areas = [
      ...Array.from({ length: 10 }, () => BODY_AREA_PX * 5),
      BODY_AREA_PX,
      BODY_AREA_PX,
      BODY_AREA_PX,
    ];
    const result = detect(areas, [0, 40, 80, 120, 160, 200, 240, 280, 320, 360, 400, 600, 800]);
    expect(result.reason).toBe('fileStart');
  });

  it('uses the same timestamp rule for an animal appearing on an empty platform', () => {
    const result = detect(
      [0, 0, 0, BODY_AREA_PX, BODY_AREA_PX, BODY_AREA_PX],
      [0, 100, 200, 600, 700, 1000],
    );
    expect(result).toMatchObject({ reason: 'animalAppeared', frame: 3 });
  });
});
