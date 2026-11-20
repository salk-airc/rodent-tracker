import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS } from '../src/paradigms/barnes/params';
import { measurementBasisIssue, videoMeasurementBasis } from '../src/paradigms/barnes/measurementBasis';
import { makeGeometry } from './helpers/synthetic';

describe('measurement provenance', () => {
  it('accepts the exact settings and outline used for tracking', () => {
    const geometry = makeGeometry(7);
    expect(measurementBasisIssue(videoMeasurementBasis(DEFAULT_PARAMS, geometry), 'video', DEFAULT_PARAMS, geometry)).toBeNull();
  });

  it('requires retracking after a pixel-setting or platform-outline change', () => {
    const geometry = makeGeometry(7);
    const basis = videoMeasurementBasis(DEFAULT_PARAMS, geometry);
    const changedParams = {
      ...DEFAULT_PARAMS,
      tracking: { ...DEFAULT_PARAMS.tracking, maxAreaRatio: 3 },
    };
    expect(measurementBasisIssue(basis, 'video', changedParams, geometry)).toMatch(/settings changed/);
    expect(measurementBasisIssue(basis, 'video', DEFAULT_PARAMS, {
      ...geometry,
      center: { x: geometry.center.x + 1, y: geometry.center.y },
    })).toMatch(/outline changed/);
  });

  it('does not require a pixel pass for ring-only edits or imported poses', () => {
    const geometry = makeGeometry(7);
    const basis = videoMeasurementBasis(DEFAULT_PARAMS, geometry);
    expect(measurementBasisIssue(basis, 'video', DEFAULT_PARAMS, {
      ...geometry,
      phaseRad: geometry.phaseRad + 0.1,
    })).toBeNull();
    expect(measurementBasisIssue({ kind: 'imported-pose' }, 'deeplabcut', DEFAULT_PARAMS, geometry)).toBeNull();
  });
});
