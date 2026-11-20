import { reanalyze, type AnalysisOutcome } from '../pipeline';
import type { RaterScoring } from '../raters';
import type { AnalysisParams, SearchStrategy } from '../types';
import { scientificReadinessReasons } from './readiness';
import { unpackObservations, type ProjectFile, type StoredVideo } from './schema';

/** Recompute one video's results under a given set of parameters. */
export function outcomeFor(video: StoredVideo, params: AnalysisParams): AnalysisOutcome {
  return reanalyze(
    {
      videoId: video.id,
      width: video.width,
      height: video.height,
      geometry: video.geometry,
      trackingSource: video.trackingSource,
      observations: unpackObservations(video.observations),
      bodyAreaPx: video.bodyAreaPx,
      bodyAreaSpread: video.bodyAreaSpread,
      detectedTrialStart: video.detectedTrialStart,
      backgroundImage: { data: new Uint8Array(0), width: 0, height: 0 },
      notes: video.notes,
    },
    {
      params,
      timebase: video.timebase,
      geometry: video.geometry,
      ...(video.trialStartOverride ? { trialStart: video.trialStartOverride } : {}),
      corrections: new Map(video.corrections.map((c) => [c.frame, c])),
    },
  );
}

/** A saved analysis is reportable only after the human-confirmation gates. */
export function storedVideoReadinessReasons(
  video: StoredVideo,
  params: AnalysisParams,
  outcome: AnalysisOutcome = outcomeFor(video, params),
): string[] {
  return scientificReadinessReasons(
    { ...video, detectedTrialStart: outcome.observations.detectedTrialStart },
    params,
    outcome.measures,
  );
}

/** Convert a project into the inter-rater comparison input. */
export function scoringFromProject(file: ProjectFile, label: string, params = file.params): RaterScoring {
  const scored = file.videos.map((video) => {
    const outcome = outcomeFor(video, params);
    return { video, outcome, reasons: storedVideoReadinessReasons(video, params, outcome) };
  });
  const provisional = scored.filter((item) => item.reasons.length > 0);
  if (provisional.length > 0) {
    throw new Error(
      `Cannot compare provisional scoring: ${provisional.map(({ video, reasons }) => `${video.fileName} (${reasons.join(', ')})`).join('; ')}.`,
    );
  }
  return {
    label,
    params,
    trials: scored.map(({ video: v, outcome }) => {
      const m = outcome.measures;
      const start = outcome.track.trialStart;
      return {
        fileName: v.fileName,
        sourceSha256: v.sourceSha256 ?? null,
        platformDiameterCm: v.geometry.platformDiameterCm,
        geometry: v.geometry,
        trackingSource: v.trackingSource,
        measurementBasis: v.measurementBasis,
        observationToolVersion: v.observationToolVersion,
        escapeHole: v.geometry.targetHoleIndex,
        escapeHoleSetBy: v.geometry.targetProvenance,
        trialStartFrame: start.frame,
        primaryLatencySec: m.primaryLatency.sec,
        primaryObserved: m.primaryLatency.observed,
        totalLatencySec: m.totalLatency.sec,
        totalObserved: m.totalLatency.observed,
        primaryErrors: m.primaryErrors,
        primaryErrorCoverage: m.primaryErrorCoverage,
        totalErrors: m.totalErrors,
        totalErrorCoverage: m.totalErrorCoverage,
        pathLengthCm: m.pathLengthCm,
        pathLengthCoverage: m.pathLengthCoverage,
        strategy: v.strategyOverride ? (v.strategyOverride.strategy as SearchStrategy) : m.strategy.strategy,
        framesCorrectedByHand: m.quality.manuallyEditedFrames,
        events: outcome.events,
      };
    }),
  };
}
