import type { MazeGeometry, TrialMeasures } from '../types';
import { holeNumber } from '../types';
import { TOOL_VERSION } from '../project/schema';
import { parameterFingerprint, resultSettings, settingsFingerprint, type ExportInput, type Table } from './tables';

export interface ReviewMeasure {
  readonly label: string;
  readonly value: number | null;
  readonly unit: string;
  readonly digits: number;
  readonly qualifier: string;
  /** The true value is at least this one, so it displays with "≥". */
  readonly lowerBound?: boolean;
  readonly provenance?: TrialMeasures['primaryLatency']['provenance'];
}

/** Presentation of existing measurements; no estimates or confirmation changes. */
export function reviewMeasures(m: TrialMeasures, geometry: MazeGeometry) {
  const hasTarget = geometry.targetHoleIndex !== null;
  const scale = geometry.platformDiameterSource === 'default' ? 'Scale unconfirmed' : '';
  const notes = (...values: string[]) => values.filter(Boolean).join('; ');
  const coverage = (fraction: number, what: string) => fraction < 1 ? `${formatPercent(fraction * 100, 0)}% ${what}` : '';
  const latency = (label: string, value: TrialMeasures['primaryLatency']): ReviewMeasure => ({
    label, value: hasTarget && Number.isFinite(value.sec) ? value.sec : null, unit: 's', digits: 2,
    qualifier: !hasTarget ? 'Set the escape hole' : value.observed ? '' : 'Not detected; lower bound',
    lowerBound: hasTarget && !value.observed,
    provenance: value.provenance,
  });
  const errors = (label: string, count: number, fraction: number): ReviewMeasure => ({
    label, value: hasTarget && fraction > 0 ? count : null, unit: '', digits: 0,
    qualifier: !hasTarget ? 'Set the escape hole' : fraction === 0 ? 'No usable tracking'
      : fraction < 1 ? `Lower bound; ${coverage(fraction, 'coverage')}` : '',
    lowerBound: hasTarget && fraction > 0 && fraction < 1,
  });
  // Distance and average speed only grow with the steps that are missing; moving speed need not.
  const path = (label: string, value: number, unit: string, digits: number, bounded: boolean): ReviewMeasure => ({
    label, value: m.pathLengthCoverage > 0 && Number.isFinite(value) ? value : null, unit, digits,
    qualifier: notes(scale, m.pathLengthCoverage === 0 ? 'No measured steps' : coverage(m.pathLengthCoverage, 'step coverage')),
    lowerBound: bounded && m.pathLengthCoverage > 0 && m.pathLengthCoverage < 1,
  });
  return {
    primaryLatency: latency('First escape-hole visit', m.primaryLatency),
    totalLatency: latency('Escape-box entry', m.totalLatency),
    primaryErrors: errors('Errors before target', m.primaryErrors, m.primaryErrorCoverage),
    totalErrors: errors('Total errors', m.totalErrors, m.totalErrorCoverage),
    pathLength: path('Measured distance', m.pathLengthCm, 'cm', 1, true),
    meanSpeed: path('Average speed', m.meanSpeedCmPerSec, 'cm/s', 2, true),
    movingSpeed: path('Speed while moving', m.meanMovingSpeedCmPerSec, 'cm/s', 2, false),
    targetQuadrant: {
      label: 'Time in target quadrant',
      value: hasTarget && m.targetQuadrantCoverage > 0 && Number.isFinite(m.timeInTargetQuadrantSec) ? m.timeInTargetQuadrantSec : null,
      unit: 's', digits: 2,
      qualifier: !hasTarget ? 'Set the escape hole' : m.targetQuadrantCoverage === 0 ? 'No measured positions'
        : coverage(m.targetQuadrantCoverage, 'position coverage'),
    },
    duration: { label: 'Trial length', value: m.trialDurationSec, unit: 's', digits: 2, qualifier: '' },
    measuredPositions: { label: 'Measured positions', value: m.quality.measuredPositionFraction * 100, unit: '%', digits: 1, qualifier: '' },
  } satisfies Record<string, ReviewMeasure>;
}

export function formatReviewValue(measure: ReviewMeasure): string {
  if (measure.value === null || !Number.isFinite(measure.value)) return 'Unavailable';
  const text = measure.unit === '%' ? formatPercent(measure.value, measure.digits) : measure.value.toFixed(measure.digits);
  return measure.lowerBound ? `≥ ${text}` : text;
}

/** Rounding must not turn partial coverage into complete or absent coverage. */
function formatPercent(value: number, digits: number): string {
  const rounded = value.toFixed(digits);
  if (value < 100 && Number(rounded) === 100) return '<100';
  if (value > 0 && Number(rounded) === 0) return `<${10 ** -digits}`;
  return rounded;
}

/** A readable first sheet; full numeric provenance remains in Trial summary. */
export function trialOverviewTable(inputs: ReadonlyArray<ExportInput>): Table {
  return {
    name: 'Overview',
    description: 'One row per analyzed trial. Provisional rows retain unconfirmed inputs. Detailed values and provenance are in Trial summary.',
    columns: [
      'Recording', 'Animal', 'Group', 'Day', 'Trial', 'Result status', 'Review needed',
      'First escape-hole visit (s)', 'First visit observed', 'Escape-box entry (s)', 'Entry observed',
      'Errors before target', 'Total errors', 'Measured distance (cm)', 'Average speed (cm/s)',
      'Time in target quadrant (s)', 'Search strategy', 'Measured positions (%)',
      'Measurement notes', 'Target hole', 'Diameter (cm)', 'Tool version',
      'Parameter fingerprint', 'Result settings fingerprint',
    ],
    rows: inputs.map((input) => {
      const m = input.measures;
      const measures = reviewMeasures(m, input.geometry);
      const value = (measure: ReviewMeasure) => {
        if (measure.value === null || !Number.isFinite(measure.value)) return null;
        return measure.unit === '%' ? measure.value : Number(measure.value.toFixed(measure.digits));
      };
      return [
        input.fileName, input.meta.animalId, input.meta.group, input.meta.day, input.meta.trial,
        input.resultStatus, input.provisionalReasons.join('; '),
        value(measures.primaryLatency), input.geometry.targetHoleIndex === null ? null : m.primaryLatency.observed,
        value(measures.totalLatency), input.geometry.targetHoleIndex === null ? null : m.totalLatency.observed,
        value(measures.primaryErrors), value(measures.totalErrors), value(measures.pathLength), value(measures.meanSpeed), value(measures.targetQuadrant),
        input.strategyOverride?.strategy ?? m.strategy.strategy, value(measures.measuredPositions),
        Object.values(measures).filter((measure) => measure.qualifier).map((measure) => `${measure.label}: ${measure.qualifier}`).join(' | '),
        input.geometry.targetHoleIndex === null ? null : holeNumber(input.geometry, input.geometry.targetHoleIndex),
        input.geometry.platformDiameterCm, TOOL_VERSION,
        parameterFingerprint(input.params), settingsFingerprint(input.params, resultSettings(input)),
      ];
    }),
  };
}
