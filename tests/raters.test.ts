import { describe, expect, it } from 'vitest';
import { cohensKappa, compareRaters, type RaterScoring, type RaterTrial } from '../src/paradigms/barnes/raters';
import { DEFAULT_PARAMS } from '../src/paradigms/barnes/params';
import { videoMeasurementBasis } from '../src/paradigms/barnes/measurementBasis';
import type { HoleEvent } from '../src/paradigms/barnes/types';
import { makeGeometry } from './helpers/synthetic';

const MEASUREMENT_BASIS = videoMeasurementBasis(DEFAULT_PARAMS, makeGeometry(7));

const event = (id: string, hole: number, startFrame: number, endFrame: number, over: Partial<HoleEvent> = {}): HoleEvent => ({
  id,
  type: 'investigation',
  holeIndex: hole,
  startFrame,
  endFrame,
  isTarget: false,
  isError: true,
  minNoseDistanceCm: 1,
  minAreaRatio: 0.9,
  provenance: 'auto',
  evidence: 'test',
  ...over,
});

const trial = (fileName: string, over: Partial<RaterTrial> = {}): RaterTrial => ({
  fileName,
  sourceSha256: 'a'.repeat(64),
  platformDiameterCm: 91.5,
  trackingSource: 'video',
  observationToolVersion: '0.2.0',
  escapeHole: 7,
  escapeHoleSetBy: 'manual',
  trialStartFrame: 0,
  primaryLatencySec: 10,
  primaryObserved: true,
  totalLatencySec: 20,
  totalObserved: true,
  primaryErrors: 2,
  primaryErrorCoverage: 1,
  totalErrors: 4,
  totalErrorCoverage: 1,
  pathLengthCm: 500,
  pathLengthCoverage: 1,
  strategy: 'spatial',
  framesCorrectedByHand: 0,
  events: [],
  ...over,
  geometry: over.geometry ?? makeGeometry(7),
  measurementBasis: over.measurementBasis ?? MEASUREMENT_BASIS,
});

const scoring = (label: string, trials: RaterTrial[], params = DEFAULT_PARAMS): RaterScoring => ({ label, params, trials });

describe('comparing two scorings', () => {
  it('excludes missing or mismatched content identities instead of trusting a filename', () => {
    const a = scoring('Ana', [trial('missing.mp4', { sourceSha256: null }), trial('different.mp4'), trial('same.mp4')]);
    const b = scoring('Ben', [trial('missing.mp4'), trial('different.mp4', { sourceSha256: 'b'.repeat(64) }), trial('same.mp4')]);
    const comparison = compareRaters(a, b);
    expect(comparison.commonRecordings).toEqual(['same.mp4']);
    expect(comparison.identityExclusions.map((item) => item.fileName)).toEqual(['missing.mp4', 'different.mp4']);
    expect(comparison.strategy.total).toBe(1);
    expect(comparison.measures.every((measure) => measure.n === 1)).toBe(true);
  });

  it('refuses ambiguous duplicate recording names instead of dropping a trial', () => {
    const a = scoring('Ana', [trial('same.mp4'), trial('same.mp4')]);
    const b = scoring('Ben', [trial('same.mp4')]);

    expect(() => compareRaters(a, b)).toThrow(/repeated recording names/);
  });

  it('reports perfect agreement when they are identical', () => {
    const trials = [trial('a.mp4'), trial('b.mp4')];
    const c = compareRaters(scoring('Ana', trials), scoring('Ben', trials));
    expect(c.sameSettings).toBe(true);
    expect(c.strategy.agreed).toBe(2);
    expect(c.escapeHoleDisagreements).toEqual([]);
    expect(c.measures.every((m) => m.meanAbsoluteDifference === 0)).toBe(true);
    expect(c.findings[0]).toMatch(/matching source-video SHA-256/);
  });

  /**
   * The failure this whole module exists for. A student counted nose-pokes
   * differently for a semester; the problem was not that they were wrong, it was
   * that the disagreement was invisible. A consistent offset has to be called
   * out as an offset, not averaged into a vague "they differ".
   */
  it('names a consistent offset in error counts and says who is higher', () => {
    const a = [trial('a.mp4', { totalErrors: 3 }), trial('b.mp4', { totalErrors: 4 }), trial('c.mp4', { totalErrors: 5 })];
    const b = [trial('a.mp4', { totalErrors: 6 }), trial('b.mp4', { totalErrors: 7 }), trial('c.mp4', { totalErrors: 8 })];
    const c = compareRaters(scoring('Ana', a), scoring('Ben', b));
    const errors = c.measures.find((m) => m.measure === 'errors in total')!;
    expect(errors.meanDifference).toBe(3);
    // Correlation is perfect despite the offset, which is exactly why the
    // difference is reported next to it rather than replaced by it.
    expect(errors.correlation).toBeCloseTo(1, 5);
    expect(c.findings.join(' ')).toMatch(/Ben counts 3\.0 more errors/);
  });

  it('flags different settings first, because they make everything else ambiguous', () => {
    const loose = { ...DEFAULT_PARAMS, events: { ...DEFAULT_PARAMS.events, investigationRadiusCm: 2 } };
    const c = compareRaters(scoring('Ana', [trial('a.mp4')]), scoring('Ben', [trial('a.mp4')], loose));
    expect(c.sameSettings).toBe(false);
    expect(c.settingsDifferences).toEqual([{ parameter: 'events.investigationRadiusCm', a: 3, b: 2 }]);
    expect(c.findings[0]).toMatch(/different settings/);
    expect(c.findings[0]).toMatch(/investigationRadiusCm/);
  });

  it('does not call centimeter results comparable when physical scales differ', () => {
    const c = compareRaters(
      scoring('Ana', [trial('a.mp4', { platformDiameterCm: 91.5 })]),
      scoring('Ben', [trial('a.mp4', { platformDiameterCm: 100 })]),
    );
    expect(c.sameSettings).toBe(false);
    expect(c.fingerprintA).not.toBe(c.fingerprintB);
    expect(c.settingsDifferences).toEqual([
      { parameter: 'platformDiameterCm[a.mp4]', a: 91.5, b: 100 },
    ]);
    expect(c.findings[0]).toMatch(/different settings/);
  });

  it('does not call native and imported tracking identical inputs', () => {
    const c = compareRaters(
      scoring('Ana', [trial('a.mp4', { trackingSource: 'video' })]),
      scoring('Ben', [trial('a.mp4', { trackingSource: 'deeplabcut', measurementBasis: { kind: 'imported-pose' } })]),
    );
    expect(c.sameSettings).toBe(false);
    expect(c.fingerprintA).not.toBe(c.fingerprintB);
    expect(c.settingsDifferences).toEqual(expect.arrayContaining([
      { parameter: 'trackingSource[a.mp4]', a: 'video', b: 'deeplabcut' },
    ]));
  });

  it('does not call different pixel-measurement bases identical inputs', () => {
    if (MEASUREMENT_BASIS.kind !== 'video') throw new Error('Expected a video measurement basis.');
    const changed = {
      ...MEASUREMENT_BASIS,
      tracking: { ...MEASUREMENT_BASIS.tracking, darkThreshold: 40 },
    };
    const c = compareRaters(
      scoring('Ana', [trial('a.mp4')]),
      scoring('Ben', [trial('a.mp4', { measurementBasis: changed })]),
    );
    expect(c.sameSettings).toBe(false);
    expect(c.settingsDifferences[0]?.parameter).toBe('measurementBasis[a.mp4]');
  });

  it('does not call observations from different tracker versions identical inputs', () => {
    const c = compareRaters(
      scoring('Ana', [trial('a.mp4', { observationToolVersion: '0.1.0' })]),
      scoring('Ben', [trial('a.mp4', { observationToolVersion: '0.2.0' })]),
    );
    expect(c.sameSettings).toBe(false);
    expect(c.settingsDifferences).toEqual([
      { parameter: 'observationToolVersion[a.mp4]', a: '0.1.0', b: '0.2.0' },
    ]);
  });

  it('puts a disagreement about the escape hole near the top', () => {
    const c = compareRaters(
      scoring('Ana', [trial('a.mp4', { escapeHole: 7 })]),
      scoring('Ben', [trial('a.mp4', { escapeHole: 12 })]),
    );
    expect(c.escapeHoleDisagreements).toEqual([{ fileName: 'a.mp4', a: 8, b: 13 }]);
    expect(c.sameSettings).toBe(false);
    expect(c.fingerprintA).not.toBe(c.fingerprintB);
    expect(c.findings.join(' ')).toMatch(/disagree about which hole is the escape hole/);
  });

  it('treats maze layout and trial start as result-defining settings', () => {
    const geometry = makeGeometry(7);
    const shifted = {
      ...geometry,
      holes: geometry.holes.map((hole) =>
        hole.index === 3 ? { ...hole, center: { ...hole.center, x: hole.center.x + 12 } } : hole,
      ),
    };
    const layout = compareRaters(
      scoring('Ana', [trial('a.mp4', { geometry })]),
      scoring('Ben', [trial('a.mp4', { geometry: shifted })]),
    );
    expect(layout.sameSettings).toBe(false);
    expect(layout.settingsDifferences.some((difference) => difference.parameter === 'mazeLayout[a.mp4]')).toBe(true);

    const start = compareRaters(
      scoring('Ana', [trial('a.mp4', { trialStartFrame: 0 })]),
      scoring('Ben', [trial('a.mp4', { trialStartFrame: 10 })]),
    );
    expect(start.sameSettings).toBe(false);
    expect(start.fingerprintA).not.toBe(start.fingerprintB);
  });

  it('excludes censored latencies rather than differencing them against measured ones', () => {
    const a = [trial('a.mp4', { totalLatencySec: 180, totalObserved: false }), trial('b.mp4', { totalLatencySec: 20 })];
    const b = [trial('a.mp4', { totalLatencySec: 25, totalObserved: true }), trial('b.mp4', { totalLatencySec: 22 })];
    const c = compareRaters(scoring('Ana', a), scoring('Ben', b));
    const total = c.measures.find((m) => m.measure === 'total latency')!;
    expect(total.censoredExcluded).toBe(1);
    expect(total.n).toBe(1);
    expect(total.meanDifference).toBe(2);
  });

  it('excludes a measure that was unavailable to either scorer', () => {
    const a = [trial('a.mp4', { pathLengthCm: Number.NaN }), trial('b.mp4', { pathLengthCm: 100 })];
    const b = [trial('a.mp4', { pathLengthCm: 80 }), trial('b.mp4', { pathLengthCm: 110 })];
    const comparison = compareRaters(scoring('Ana', a), scoring('Ben', b));
    const path = comparison.measures.find((measure) => measure.measure === 'path length')!;
    expect(path.unavailableExcluded).toBe(1);
    expect(path.n).toBe(1);
    expect(path.meanDifference).toBe(10);
  });

  it('does not compare lower-bound error counts as exact', () => {
    const a = [trial('a.mp4', { primaryErrors: 2, primaryErrorCoverage: 0.7, totalErrors: 4, totalErrorCoverage: 1 })];
    const b = [trial('a.mp4', { primaryErrors: 2, primaryErrorCoverage: 1, totalErrors: 9, totalErrorCoverage: 0.8 })];
    const comparison = compareRaters(scoring('Ana', a), scoring('Ben', b));

    expect(comparison.measures.find((measure) => measure.measure === 'errors before finding it')).toMatchObject({
      n: 0,
      unavailableExcluded: 1,
    });
    expect(comparison.measures.find((measure) => measure.measure === 'errors in total')).toMatchObject({
      n: 0,
      unavailableExcluded: 1,
    });
  });

  it('matches hole visits on hole and overlapping time', () => {
    const a = [trial('a.mp4', { events: [event('a1', 5, 100, 120), event('a2', 9, 200, 220)] })];
    const b = [trial('a.mp4', { events: [event('b1', 5, 110, 130), event('b2', 12, 300, 320)] })];
    const c = compareRaters(scoring('Ana', a), scoring('Ben', b));
    const ev = c.events[0]!;
    expect(ev.agreed).toBe(1);
    expect(ev.onlyInA).toBe(1);
    expect(ev.onlyInB).toBe(1);
    expect(ev.jaccard).toBeCloseTo(1 / 3, 5);
  });

  it('does not match visits to the same hole at different times', () => {
    const a = [trial('a.mp4', { events: [event('a1', 5, 100, 120)] })];
    const b = [trial('a.mp4', { events: [event('b1', 5, 500, 520)] })];
    expect(compareRaters(scoring('Ana', a), scoring('Ben', b)).events[0]!.agreed).toBe(0);
  });

  it('does not double-match one visit against two', () => {
    const a = [trial('a.mp4', { events: [event('a1', 5, 100, 200)] })];
    const b = [trial('a.mp4', { events: [event('b1', 5, 110, 130), event('b2', 5, 150, 170)] })];
    const ev = compareRaters(scoring('Ana', a), scoring('Ben', b)).events[0]!;
    expect(ev.agreed).toBe(1);
    expect(ev.onlyInB).toBe(1);
  });

  it('says so when the two have no recordings in common', () => {
    const c = compareRaters(scoring('Ana', [trial('a.mp4')]), scoring('Ben', [trial('z.mp4')]));
    expect(c.commonRecordings).toEqual([]);
    expect(c.findings[0]).toMatch(/no verified recordings in common/);
  });

  it('lists recordings only one of them scored', () => {
    const c = compareRaters(scoring('Ana', [trial('a.mp4'), trial('b.mp4')]), scoring('Ben', [trial('b.mp4'), trial('c.mp4')]));
    expect(c.onlyInA).toEqual(['a.mp4']);
    expect(c.onlyInB).toEqual(['c.mp4']);
    expect(c.commonRecordings).toEqual(['b.mp4']);
  });

  it('reports who corrected more frames by hand', () => {
    const c = compareRaters(
      scoring('Ana', [trial('a.mp4', { framesCorrectedByHand: 12 })]),
      scoring('Ben', [trial('a.mp4', { framesCorrectedByHand: 0 })]),
    );
    expect(c.findings.join(' ')).toMatch(/Ana corrected 12 frames by hand, Ben corrected 0/);
  });
});

describe('cohensKappa', () => {
  /**
   * Kappa rather than raw agreement, because three of the four strategy labels
   * are common and two scorers who both label everything "random" would agree
   * perfectly by accident.
   */
  it('is 1 for perfect agreement', () => {
    expect(cohensKappa(['a', 'b', 'c', 'a'], ['a', 'b', 'c', 'a'])).toBeCloseTo(1, 6);
  });

  it('is near 0 when agreement is what chance would give', () => {
    const a = ['x', 'x', 'y', 'y'];
    const b = ['x', 'y', 'x', 'y'];
    expect(Math.abs(cohensKappa(a, b))).toBeLessThan(0.001);
  });

  it('is negative when they agree less than chance', () => {
    expect(cohensKappa(['x', 'x', 'y', 'y'], ['y', 'y', 'x', 'x'])).toBeLessThan(0);
  });

  it('is not computable when both scorers used the same single label throughout', () => {
    // Both label everything the same: agreement is 1 but so is chance agreement,
    // so kappa is undefined rather than perfect.
    expect(Number.isNaN(cohensKappa(['x', 'x', 'x'], ['x', 'x', 'x']))).toBe(true);
    expect(cohensKappa(['x', 'x', 'x'], ['y', 'y', 'y'])).toBe(0);
  });

  it('is NaN for an empty comparison', () => {
    expect(Number.isNaN(cohensKappa([], []))).toBe(true);
  });
});
