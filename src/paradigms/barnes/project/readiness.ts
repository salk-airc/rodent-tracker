import { measurementBasisIssue } from '../measurementBasis';
import type { AnalysisParams, MazeGeometry, MeasurementBasis, TrackingSource, TrialStart } from '../types';

/** The evidence/confirmation fields shared by live and saved recordings. */
export interface ResultReadinessRecord {
  readonly mazeConfirmed: boolean;
  readonly geometry: MazeGeometry | null;
  readonly trackingSource: TrackingSource;
  readonly measurementBasis: MeasurementBasis | null;
  readonly detectedTrialStart: TrialStart | null;
  readonly trialStartOverride: TrialStart | null;
}

export interface ResultReadinessEvidence {
  readonly primaryErrorCoverage: number;
  readonly totalErrorCoverage: number;
}

/** Reasons a derived analysis is still for inspection rather than reporting. */
export function scientificReadinessReasons(
  record: ResultReadinessRecord,
  params: AnalysisParams,
  evidence: ResultReadinessEvidence,
): string[] {
  const reasons: string[] = [];
  if (record.mazeConfirmed !== true) reasons.push('maze not confirmed');
  if (!record.geometry || record.geometry.platformDiameterSource === 'default') {
    reasons.push('platform diameter not confirmed');
  }
  if (record.geometry?.targetHoleIndex === null || !record.geometry) reasons.push('escape hole unavailable');
  else if (record.geometry.targetProvenance !== 'manual') reasons.push('escape hole not confirmed');
  const start = record.trialStartOverride ?? record.detectedTrialStart;
  if (!start) reasons.push('trial start unavailable');
  else if (start.reason === 'fileStart' && start.provenance !== 'manual') reasons.push('trial start not confirmed');
  if (record.geometry) {
    const issue = measurementBasisIssue(record.measurementBasis, record.trackingSource, params, record.geometry);
    if (issue) reasons.push(issue);
  }
  if (evidence.primaryErrorCoverage < 1 || evidence.totalErrorCoverage < 1) {
    reasons.push('error counts have incomplete tracking coverage');
  }
  return reasons;
}
