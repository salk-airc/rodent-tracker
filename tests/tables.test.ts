import { describe, expect, it } from 'vitest';
import { exclusionsTable, parameterFingerprint, settingsFingerprint, validateTableShape } from '../src/io/tables';
import { DEFAULT_PARAMS } from '../src/params';
import { videoMeasurementBasis } from '../src/measurementBasis';
import { makeGeometry } from './helpers/synthetic';

const BASIS = videoMeasurementBasis(DEFAULT_PARAMS, makeGeometry(7));

describe('parameter provenance', () => {
  const at = (platformDiameterCm: number, targetHoleIndex = 7, trialStartFrame = 0) => ({
    geometry: makeGeometry(targetHoleIndex, platformDiameterCm),
    trialStartFrame,
    trackingSource: 'video' as const,
    observationToolVersion: '0.2.0',
    measurementBasis: BASIS,
  });

  it('changes the fingerprint for both top-level and nested setting changes', () => {
    const original = parameterFingerprint(DEFAULT_PARAMS);
    const topLevel = parameterFingerprint({ ...DEFAULT_PARAMS, trialCutoffSec: 120 });
    const nested = parameterFingerprint({
      ...DEFAULT_PARAMS,
      events: { ...DEFAULT_PARAMS.events, investigationRadiusCm: 2 },
    });

    expect(topLevel).not.toBe(original);
    expect(nested).not.toBe(original);
    expect(nested).not.toBe(topLevel);
  });

  it('does not depend on object property insertion order', () => {
    const reordered = {
      speedWindowSec: DEFAULT_PARAMS.speedWindowSec,
      smoothingWindowFrames: DEFAULT_PARAMS.smoothingWindowFrames,
      maxInterpolateGapFrames: DEFAULT_PARAMS.maxInterpolateGapFrames,
      movingSpeedThresholdCmPerSec: DEFAULT_PARAMS.movingSpeedThresholdCmPerSec,
      centerZoneFraction: DEFAULT_PARAMS.centerZoneFraction,
      trialCutoffSec: DEFAULT_PARAMS.trialCutoffSec,
      strategy: { ...DEFAULT_PARAMS.strategy },
      events: { ...DEFAULT_PARAMS.events },
      tracking: { ...DEFAULT_PARAMS.tracking },
    };
    expect(parameterFingerprint(reordered)).toBe(parameterFingerprint(DEFAULT_PARAMS));
  });

  it('includes physical scale in a result settings fingerprint', () => {
    expect(settingsFingerprint(DEFAULT_PARAMS, at(91.5))).not.toBe(settingsFingerprint(DEFAULT_PARAMS, at(100)));
    expect(settingsFingerprint(DEFAULT_PARAMS, at(91.5))).toBe(settingsFingerprint(DEFAULT_PARAMS, at(91.5)));
  });

  it('includes tracking source in a result settings fingerprint', () => {
    const native = settingsFingerprint(DEFAULT_PARAMS, {
      ...at(91.5), trackingSource: 'video', observationToolVersion: '0.2.0',
      measurementBasis: BASIS,
    });
    const imported = settingsFingerprint(DEFAULT_PARAMS, {
      ...at(91.5), trackingSource: 'deeplabcut', observationToolVersion: null,
      measurementBasis: { kind: 'imported-pose' },
    });
    expect(native).not.toBe(imported);
  });

  it('makes cohort scale fingerprints independent of recording order', () => {
    const first = settingsFingerprint(DEFAULT_PARAMS, [
      { recording: 'b.mp4', ...at(100) },
      { recording: 'a.mp4', ...at(91.5) },
    ]);
    const second = settingsFingerprint(DEFAULT_PARAMS, [
      { recording: 'a.mp4', ...at(91.5) },
      { recording: 'b.mp4', ...at(100) },
    ]);
    expect(first).toBe(second);
  });

  it('includes the escape hole, maze layout, and effective trial start', () => {
    const original = settingsFingerprint(DEFAULT_PARAMS, at(91.5, 7, 0));
    expect(settingsFingerprint(DEFAULT_PARAMS, at(91.5, 8, 0))).not.toBe(original);
    expect(settingsFingerprint(DEFAULT_PARAMS, at(91.5, 7, 12))).not.toBe(original);
    const base = makeGeometry(7);
    const moved = {
      ...base,
      holes: base.holes.map((hole) =>
        hole.index === 3
          ? { ...hole, center: { ...hole.center, x: hole.center.x + 12 } }
          : hole,
      ),
    };
    expect(settingsFingerprint(DEFAULT_PARAMS, { ...at(91.5), geometry: moved })).not.toBe(original);
  });
});

describe('exclusion manifest', () => {
  it('identifies every recording omitted from reportable tables', () => {
    const table = exclusionsTable([{ id: 'v2', fileName: 'bad.mp4', reason: 'analysis failed' }]);
    expect(table.rows).toEqual([['v2', 'bad.mp4', 'reportable results', 'analysis failed']]);
    expect(() => validateTableShape(table)).not.toThrow();
  });
});
