/** Compare two scorings on settings, measures, events, and strategy. */

import { holeNumber, type AnalysisParams, type HoleEvent, type MazeGeometry, type MeasurementBasis, type SearchStrategy, type TrackingSource } from './types';
import { mazeLayoutFingerprint, measurementFingerprint, settingsFingerprint } from './io/tables';
import { isVideoHash } from './project/identity';
import { mean, round } from './stats';

export interface RaterScoring {
  /** How this scoring is labeled in the report, e.g. a person's name. */
  readonly label: string;
  readonly params: AnalysisParams;
  readonly trials: ReadonlyArray<RaterTrial>;
}

export interface RaterTrial {
  /** Names identify candidate pairs; only matching source hashes enter the comparison. */
  readonly fileName: string;
  readonly sourceSha256?: string | null;
  /** Confirmed physical scale used for centimeter-based measures. */
  readonly platformDiameterCm: number;
  readonly geometry: MazeGeometry;
  readonly trackingSource: TrackingSource;
  readonly measurementBasis: MeasurementBasis | null;
  readonly observationToolVersion: string | null;
  readonly escapeHole: number | null;
  readonly escapeHoleSetBy: string;
  readonly trialStartFrame: number;
  readonly primaryLatencySec: number;
  readonly primaryObserved: boolean;
  readonly totalLatencySec: number;
  readonly totalObserved: boolean;
  readonly primaryErrors: number;
  readonly primaryErrorCoverage: number;
  readonly totalErrors: number;
  readonly totalErrorCoverage: number;
  readonly pathLengthCm: number;
  readonly pathLengthCoverage: number;
  readonly strategy: SearchStrategy;
  readonly framesCorrectedByHand: number;
  readonly events: ReadonlyArray<HoleEvent>;
}

export interface MeasureAgreement {
  readonly measure: string;
  readonly unit: string;
  readonly n: number;
  /** Mean of (b - a). A consistent sign means one scorer reads systematically higher. */
  readonly meanDifference: number;
  readonly meanAbsoluteDifference: number;
  readonly maxAbsoluteDifference: number;
  readonly worstTrial: string | null;
  /**
   * Pearson correlation between the two scorings.
   *
   * Reported alongside the differences rather than instead of them, because a
   * correlation near 1 is perfectly compatible with one scorer reading five
   * seconds high on every trial, which is exactly the failure this is looking
   * for.
   */
  readonly correlation: number;
  /** Trials where either scoring was censored; excluded from the statistics above. */
  readonly censoredExcluded: number;
  /** Trials where either scoring had no measured value. */
  readonly unavailableExcluded: number;
}

export interface EventAgreement {
  readonly fileName: string;
  /** Hole visits both found, matched on hole and overlapping time. */
  readonly agreed: number;
  readonly onlyInA: number;
  readonly onlyInB: number;
  /**
   * Agreed as a share of all visits either found. 1.0 is perfect. Reported per
   * recording, because a single badly-tracked video can carry the whole
   * disagreement and the cohort average would hide it.
   */
  readonly jaccard: number;
  readonly disagreements: ReadonlyArray<{ readonly hole: number; readonly onlyIn: 'A' | 'B'; readonly startFrame: number }>;
}

export interface RaterComparison {
  readonly identityExclusions: ReadonlyArray<{ readonly fileName: string; readonly reason: string }>;
  readonly a: string;
  readonly b: string;
  readonly sameSettings: boolean;
  readonly fingerprintA: string;
  readonly fingerprintB: string;
  readonly settingsDifferences: ReadonlyArray<{ readonly parameter: string; readonly a: unknown; readonly b: unknown }>;
  readonly commonRecordings: ReadonlyArray<string>;
  readonly onlyInA: ReadonlyArray<string>;
  readonly onlyInB: ReadonlyArray<string>;
  readonly measures: ReadonlyArray<MeasureAgreement>;
  readonly events: ReadonlyArray<EventAgreement>;
  readonly escapeHoleDisagreements: ReadonlyArray<{ readonly fileName: string; readonly a: number | null; readonly b: number | null }>;
  readonly strategy: {
    readonly agreed: number;
    readonly total: number;
    readonly kappa: number;
    readonly disagreements: ReadonlyArray<{ readonly fileName: string; readonly a: SearchStrategy; readonly b: SearchStrategy }>;
  };
  /** Plain-English findings, most important first. */
  readonly findings: ReadonlyArray<string>;
}

/** Two hole visits count as the same visit if they are at the same hole and overlap in time. */
function overlaps(x: HoleEvent, y: HoleEvent): boolean {
  return x.holeIndex === y.holeIndex && x.startFrame <= y.endFrame && y.startFrame <= x.endFrame;
}

export function compareRaters(a: RaterScoring, b: RaterScoring): RaterComparison {
  assertUniqueFileNames(a);
  assertUniqueFileNames(b);
  const namesA = new Set(a.trials.map((t) => t.fileName));
  const namesB = new Set(b.trials.map((t) => t.fileName));
  const byA = new Map(a.trials.map((t) => [t.fileName, t]));
  const byB = new Map(b.trials.map((t) => [t.fileName, t]));
  const identityExclusions: { fileName: string; reason: string }[] = [];
  const common = [...namesA].filter((name) => {
    if (!namesB.has(name)) return false;
    const hashA = byA.get(name)!.sourceSha256;
    const hashB = byB.get(name)!.sourceSha256;
    const reason = !isVideoHash(hashA) || !isVideoHash(hashB)
      ? 'Source identity is missing. Reconnect the original video and save both projects before comparing.'
      : hashA !== hashB ? 'The files have different content despite sharing a name.' : null;
    if (reason) identityExclusions.push({ fileName: name, reason });
    return reason === null;
  }).sort();
  const settingsDifferences = [
    ...diffParams(a.params, b.params),
    ...common.flatMap((name) => {
      const diameterA = byA.get(name)!.platformDiameterCm;
      const diameterB = byB.get(name)!.platformDiameterCm;
      return diameterA === diameterB
        ? []
        : [{ parameter: `platformDiameterCm[${name}]`, a: diameterA, b: diameterB }];
    }),
    ...common.flatMap((name) => {
      const layoutA = mazeLayoutFingerprint(byA.get(name)!.geometry);
      const layoutB = mazeLayoutFingerprint(byB.get(name)!.geometry);
      return layoutA === layoutB
        ? []
        : [{ parameter: `mazeLayout[${name}]`, a: layoutA, b: layoutB }];
    }),
    ...common.flatMap((name) => {
      const targetA = byA.get(name)!.escapeHole;
      const targetB = byB.get(name)!.escapeHole;
      return targetA === targetB
        ? []
        : [{
            parameter: `escapeHole[${name}]`,
            a: targetA === null ? null : holeNumber(byA.get(name)!.geometry, targetA),
            b: targetB === null ? null : holeNumber(byB.get(name)!.geometry, targetB),
          }];
    }),
    ...common.flatMap((name) => {
      const startA = byA.get(name)!.trialStartFrame;
      const startB = byB.get(name)!.trialStartFrame;
      return startA === startB
        ? []
        : [{ parameter: `trialStartFrame[${name}]`, a: startA, b: startB }];
    }),
    ...common.flatMap((name) => {
      const sourceA = byA.get(name)!.trackingSource;
      const sourceB = byB.get(name)!.trackingSource;
      return sourceA === sourceB
        ? []
        : [{ parameter: `trackingSource[${name}]`, a: sourceA, b: sourceB }];
    }),
    ...common.flatMap((name) => {
      const basisA = measurementFingerprint(byA.get(name)!.measurementBasis);
      const basisB = measurementFingerprint(byB.get(name)!.measurementBasis);
      return basisA === basisB
        ? []
        : [{ parameter: `measurementBasis[${name}]`, a: basisA, b: basisB }];
    }),
    ...common.flatMap((name) => {
      const versionA = byA.get(name)!.observationToolVersion;
      const versionB = byB.get(name)!.observationToolVersion;
      return versionA === versionB
        ? []
        : [{ parameter: `observationToolVersion[${name}]`, a: versionA, b: versionB }];
    }),
  ];
  const fingerprintA = settingsFingerprint(
    a.params,
    common.map((recording) => ({
      recording,
      geometry: resultGeometry(byA.get(recording)!),
      trialStartFrame: byA.get(recording)!.trialStartFrame,
      trackingSource: byA.get(recording)!.trackingSource,
      observationToolVersion: byA.get(recording)!.observationToolVersion,
      measurementBasis: byA.get(recording)!.measurementBasis,
    })),
  );
  const fingerprintB = settingsFingerprint(
    b.params,
    common.map((recording) => ({
      recording,
      geometry: resultGeometry(byB.get(recording)!),
      trialStartFrame: byB.get(recording)!.trialStartFrame,
      trackingSource: byB.get(recording)!.trackingSource,
      observationToolVersion: byB.get(recording)!.observationToolVersion,
      measurementBasis: byB.get(recording)!.measurementBasis,
    })),
  );
  const sameSettings = settingsDifferences.length === 0;

  const measures = [
    measureAgreement('primary latency', 's', common, byA, byB, (t) => t.primaryLatencySec, (t) => t.primaryObserved),
    measureAgreement('total latency', 's', common, byA, byB, (t) => t.totalLatencySec, (t) => t.totalObserved),
    measureAgreement(
      'errors before finding it', 'holes', common, byA, byB,
      (t) => t.primaryErrors, undefined, (t) => t.primaryErrorCoverage === 1,
    ),
    measureAgreement(
      'errors in total', 'holes', common, byA, byB,
      (t) => t.totalErrors, undefined, (t) => t.totalErrorCoverage === 1,
    ),
    measureAgreement(
      'path length',
      'cm',
      common,
      byA,
      byB,
      (t) => t.pathLengthCm,
      undefined,
      (t) => t.pathLengthCoverage === 1,
    ),
  ];

  const events: EventAgreement[] = common.map((name) => {
    const ea = (byA.get(name)?.events ?? []).filter((e) => e.type === 'investigation');
    const eb = (byB.get(name)?.events ?? []).filter((e) => e.type === 'investigation');
    const matchedB = new Set<string>();
    let agreed = 0;
    const disagreements: { hole: number; onlyIn: 'A' | 'B'; startFrame: number }[] = [];
    for (const x of ea) {
      const hit = eb.find((y) => !matchedB.has(y.id) && overlaps(x, y));
      if (hit) {
        matchedB.add(hit.id);
        agreed++;
      } else {
        disagreements.push({ hole: holeNumber(byA.get(name)!.geometry, x.holeIndex), onlyIn: 'A', startFrame: x.startFrame });
      }
    }
    for (const y of eb) {
      if (!matchedB.has(y.id)) disagreements.push({ hole: holeNumber(byB.get(name)!.geometry, y.holeIndex), onlyIn: 'B', startFrame: y.startFrame });
    }
    const union = agreed + disagreements.length;
    return {
      fileName: name,
      agreed,
      onlyInA: disagreements.filter((d) => d.onlyIn === 'A').length,
      onlyInB: disagreements.filter((d) => d.onlyIn === 'B').length,
      jaccard: union > 0 ? agreed / union : 1,
      disagreements: disagreements.sort((p, q) => p.startFrame - q.startFrame).slice(0, 40),
    };
  });

  const escapeHoleDisagreements = common
    .map((name) => {
      const targetA = byA.get(name)!.escapeHole;
      const targetB = byB.get(name)!.escapeHole;
      return {
        fileName: name,
        a: targetA === null ? null : holeNumber(byA.get(name)!.geometry, targetA),
        b: targetB === null ? null : holeNumber(byB.get(name)!.geometry, targetB),
      };
    })
    .filter((d) => d.a !== d.b);

  const strategyPairs = common.map((name) => ({
    fileName: name,
    a: byA.get(name)!.strategy,
    b: byB.get(name)!.strategy,
  }));
  const strategyAgreed = strategyPairs.filter((p) => p.a === p.b).length;

  const comparison: RaterComparison = {
    identityExclusions,
    a: a.label,
    b: b.label,
    sameSettings,
    fingerprintA,
    fingerprintB,
    settingsDifferences,
    commonRecordings: common,
    onlyInA: [...namesA].filter((n) => !namesB.has(n)).sort(),
    onlyInB: [...namesB].filter((n) => !namesA.has(n)).sort(),
    measures,
    events,
    escapeHoleDisagreements,
    strategy: {
      agreed: strategyAgreed,
      total: strategyPairs.length,
      kappa: cohensKappa(strategyPairs.map((p) => p.a), strategyPairs.map((p) => p.b)),
      disagreements: strategyPairs.filter((p) => p.a !== p.b),
    },
    findings: [],
  };

  return { ...comparison, findings: describe(comparison, a, b) };
}

function assertUniqueFileNames(scoring: RaterScoring): void {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const trial of scoring.trials) {
    if (seen.has(trial.fileName)) repeated.add(trial.fileName);
    seen.add(trial.fileName);
  }
  if (repeated.size > 0) {
    throw new Error(
      `${scoring.label} has repeated recording names (${[...repeated].join(', ')}). ` +
        'Use unique file names before comparing scorings.',
    );
  }
}

function resultGeometry(trial: RaterTrial): MazeGeometry {
  return {
    ...trial.geometry,
    platformDiameterCm: trial.platformDiameterCm,
    targetHoleIndex: trial.escapeHole,
  };
}

function measureAgreement(
  measure: string,
  unit: string,
  common: ReadonlyArray<string>,
  byA: Map<string, RaterTrial>,
  byB: Map<string, RaterTrial>,
  get: (t: RaterTrial) => number,
  observed?: (t: RaterTrial) => boolean,
  available?: (t: RaterTrial) => boolean,
): MeasureAgreement {
  const pairs: { name: string; a: number; b: number }[] = [];
  let censoredExcluded = 0;
  let unavailableExcluded = 0;
  for (const name of common) {
    const ta = byA.get(name)!;
    const tb = byB.get(name)!;
    // A censored value is the cutoff, not a measurement, so comparing one
    // against a measured value would produce a difference that means nothing.
    if (observed && (!observed(ta) || !observed(tb))) {
      censoredExcluded++;
      continue;
    }
    if (available && (!available(ta) || !available(tb))) {
      unavailableExcluded++;
      continue;
    }
    const a = get(ta);
    const b = get(tb);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      unavailableExcluded++;
      continue;
    }
    pairs.push({ name, a, b });
  }

  const diffs = pairs.map((p) => p.b - p.a);
  const abs = diffs.map(Math.abs);
  let worstTrial: string | null = null;
  let worst = -1;
  pairs.forEach((p, i) => {
    if (abs[i]! > worst) {
      worst = abs[i]!;
      worstTrial = p.name;
    }
  });

  return {
    measure,
    unit,
    n: pairs.length,
    meanDifference: round(mean(diffs)),
    meanAbsoluteDifference: round(mean(abs)),
    maxAbsoluteDifference: round(abs.length ? Math.max(...abs) : Number.NaN),
    worstTrial,
    correlation: round(pearson(pairs.map((p) => p.a), pairs.map((p) => p.b)), 4),
    censoredExcluded,
    unavailableExcluded,
  };
}

/**
 * Cohen's kappa on the strategy labels.
 *
 * Kappa rather than raw agreement because three of the four labels are common
 * and two scorers who both label everything "random" would agree perfectly by
 * accident. Kappa discounts the agreement expected by chance.
 */
export function cohensKappa(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return Number.NaN;
  let observed = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) observed++;
  const po = observed / n;

  const labels = new Set([...a.slice(0, n), ...b.slice(0, n)]);
  let pe = 0;
  for (const label of labels) {
    const fa = a.slice(0, n).filter((x) => x === label).length / n;
    const fb = b.slice(0, n).filter((x) => x === label).length / n;
    pe += fa * fb;
  }
  if (pe >= 1) return Number.NaN;
  return (po - pe) / (1 - pe);
}

function diffParams(a: AnalysisParams, b: AnalysisParams): { parameter: string; a: unknown; b: unknown }[] {
  const out: { parameter: string; a: unknown; b: unknown }[] = [];
  const walk = (x: unknown, y: unknown, path: string) => {
    if (x && y && typeof x === 'object' && typeof y === 'object') {
      for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
        walk((x as Record<string, unknown>)[key], (y as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
      }
    } else if (x !== y) {
      out.push({ parameter: path, a: x, b: y });
    }
  };
  walk(a, b, '');
  return out;
}

/** Summarize the largest differences and required follow-up. */
function describe(c: RaterComparison, a: RaterScoring, b: RaterScoring): string[] {
  const out: string[] = [];

  if (c.commonRecordings.length === 0) {
    out.push(
      `The scorings have no verified recordings in common. ${c.identityExclusions.length} candidate pairs were excluded for missing or different video identities.`,
    );
    return out;
  }

  if (!c.sameSettings) {
    const named = c.settingsDifferences
      .slice(0, 4)
      .map((d) => `${d.parameter} (${String(d.a)} against ${String(d.b)})`)
      .join(', ');
    out.push(
      `The scorings used different settings or declared provenance: ${named}` +
        `${c.settingsDifferences.length > 4 ? `, plus ${c.settingsDifferences.length - 4} more` : ''}. ` +
        'Re-score with matching settings before comparing results.',
    );
  } else {
    out.push(
      `Declared settings and provenance fields match (fingerprint ${c.fingerprintA}). ` +
        'Paired recordings have matching source-video SHA-256 values.',
    );
  }

  const errors = c.measures.find((m) => m.measure === 'errors in total');
  if (errors && errors.n > 0) {
    if (Math.abs(errors.meanDifference) >= 1) {
      const higher = errors.meanDifference > 0 ? b.label : a.label;
      out.push(
        `${higher} counts ${Math.abs(errors.meanDifference).toFixed(1)} more errors per trial on average. Check visit definitions.`,
      );
    } else if (errors.meanAbsoluteDifference >= 1) {
      out.push(
        `Error counts differ by ${errors.meanAbsoluteDifference.toFixed(1)} per trial on average without a consistent direction.`,
      );
    }
  }

  if (c.escapeHoleDisagreements.length > 0) {
    out.push(
      `The scorings disagree about which hole is the escape hole on ${c.escapeHoleDisagreements.length} recording(s): ` +
        c.escapeHoleDisagreements.map((d) => `${d.fileName} (${d.a} against ${d.b})`).join(', ') +
        '. Resolve these labels before comparing latency or errors.',
    );
  }

  const worstEvents = [...c.events].sort((x, y) => x.jaccard - y.jaccard)[0];
  if (worstEvents && worstEvents.jaccard < 0.9) {
    out.push(
      `Lowest visit agreement: ${worstEvents.fileName}. Both: ${worstEvents.agreed}; ` +
        `${a.label} only: ${worstEvents.onlyInA}; ${b.label} only: ${worstEvents.onlyInB}. Review this recording.`,
    );
  }

  if (c.strategy.total > 0) {
    const k = c.strategy.kappa;
    const quality = Number.isNaN(k)
      ? 'not computable, because one scoring used a single label throughout'
      : k > 0.8
        ? 'strong'
        : k > 0.6
          ? 'moderate'
          : k > 0.4
            ? 'weak'
            : 'poor';
    out.push(
      `Strategy agreement: ${c.strategy.agreed} of ${c.strategy.total} trials` +
        (Number.isNaN(k) ? '' : `, kappa ${k.toFixed(2)}`) +
        ` (${quality}).`,
    );
  }

  const corrections = c.commonRecordings.map((n) => ({
    name: n,
    a: a.trials.find((t) => t.fileName === n)?.framesCorrectedByHand ?? 0,
    b: b.trials.find((t) => t.fileName === n)?.framesCorrectedByHand ?? 0,
  }));
  const totalA = corrections.reduce((s, x) => s + x.a, 0);
  const totalB = corrections.reduce((s, x) => s + x.b, 0);
  if (totalA + totalB > 0) {
    out.push(
      `${a.label} corrected ${totalA} frames by hand, ${b.label} corrected ${totalB}. Review unmatched corrections.`,
    );
  }

  return out;
}


function pearson(x: ReadonlyArray<number>, y: ReadonlyArray<number>): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return Number.NaN;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return Number.NaN;
  return sxy / Math.sqrt(sxx * syy);
}

