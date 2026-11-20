/**
 * The tables the user exports.
 *
 * The goal for these is "a person can open it in Excel and understand it
 * without a legend", which rules out a few habits: no abbreviated column names,
 * units in the header rather than assumed, and no encoding of two facts in one
 * cell. A censored latency in particular gets its own boolean column instead of
 * a sentinel value like -1 or 999, because a sentinel silently becomes a real
 * number the moment someone averages the column.
 *
 * Every table carries the tool version and a parameter fingerprint, because in
 * six months someone will ask why two cohorts disagree and the answer will be a
 * threshold.
 */

import type {
  AnalysisParams,
  HoleEvent,
  MazeGeometry,
  MeasurementBasis,
  TrackingSource,
  TrackFrame,
  TrialMeasures,
  Timebase,
} from '../types';
import { holeNumber } from '../types';
import type { GapReport } from '../tracking/resolve';
import type { VideoMeta } from '../project/schema';
import { TOOL_VERSION } from '../project/schema';
import type { ProtocolPreset } from '../project/protocol';
import { frameEndTime, frameTime } from '../time';
import { round as roundTo } from '../stats';

export interface Table {
  readonly name: string;
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>;
  /** One line explaining what a row means, written into the XLSX information sheet. */
  readonly description: string;
}

/** Fail before writing a CSV/XLSX whose values would sit under the wrong headers. */
export function validateTableShape(table: Table): void {
  if (table.columns.length === 0) throw new Error(`${table.name} has no columns.`);
  for (let index = 0; index < table.rows.length; index++) {
    const cells = table.rows[index]!.length;
    if (cells !== table.columns.length) {
      throw new Error(
        `${table.name} row ${index + 1} has ${cells} cells for ${table.columns.length} columns.`,
      );
    }
  }
}

export interface ExportInput {
  readonly sourceSha256?: string | null;
  readonly videoId: string;
  readonly fileName: string;
  readonly trackingSource: TrackingSource;
  readonly measurementBasis: MeasurementBasis | null;
  readonly observationToolVersion: string | null;
  /** Provisional rows are suitable for inspection and regression tests, not scientific reporting. */
  readonly resultStatus: 'reportable' | 'provisional';
  readonly provisionalReasons: ReadonlyArray<string>;
  readonly meta: VideoMeta;
  readonly geometry: MazeGeometry;
  readonly measures: TrialMeasures;
  readonly events: ReadonlyArray<HoleEvent>;
  readonly frames: ReadonlyArray<TrackFrame>;
  readonly gaps: ReadonlyArray<GapReport>;
  /** Deduplicated in exports; includes acquisition, geometry, tracking, event, and measure warnings. */
  readonly warnings: ReadonlyArray<string>;
  readonly params: AnalysisParams;
  readonly protocol?: ProtocolPreset | null;
  readonly timebase: Timebase;
  readonly trialStartFrame: number;
  readonly trialStartReason: string;
  /** Human strategy label, kept separate from the automatic classification. */
  readonly strategyOverride: { readonly strategy: TrialMeasures['strategy']['strategy']; readonly reason: string } | null;
  /** Null when the analysis run did not record a time. */
  readonly analyzedAt: string | null;
}

/**
 * One row per trial: the table that goes into a statistics package.
 *
 * Columns are ordered the way someone reads them — what the trial was, then the
 * headline measures, then the quality information that says whether to trust
 * them, then the provenance.
 */
export function trialSummaryTable(inputs: ReadonlyArray<ExportInput>): Table {
  const columns = [
    'video_id',
    'video_file',
    'tracking_source',
    'observation_tool_version',
    'measurement_fingerprint',
    'result_status',
    'provisional_reasons',
    ...METADATA_COLUMNS,
    'target_hole',
    'target_hole_set_by',
    'trial_start_frame',
    'trial_start_seconds',
    'trial_start_detected_by',
    'trial_duration_s',
    'primary_latency_s',
    'primary_latency_observed',
    'primary_latency_frame',
    'primary_latency_set_by',
    'total_latency_s',
    'total_latency_observed',
    'total_latency_frame',
    'total_latency_set_by',
    'primary_errors',
    'primary_errors_complete',
    'primary_error_coverage',
    'total_errors',
    'total_errors_complete',
    'total_error_coverage',
    'path_length_cm',
    'path_length_coverage',
    'mean_speed_cm_s',
    'mean_moving_speed_cm_s',
    'max_speed_cm_s',
    'time_in_target_quadrant_s',
    'target_quadrant_fraction',
    'target_quadrant_coverage',
    'search_strategy',
    'automatic_search_strategy',
    'search_strategy_rule',
    'search_strategy_set_by',
    'strategy_override_reason',
    'path_efficiency',
    'path_efficiency_coverage',
    'holes_before_target',
    'longest_serial_run',
    'center_crossings',
    'periphery_fraction',
    'mean_turn_rate_deg_s',
    'start_distance_from_target_cm',
    'frames_total',
    'frames_tracked',
    'frames_partial',
    'frames_in_hole',
    'frames_lost',
    'frames_pre_trial',
    'frames_manually_edited',
    'frames_measured_position',
    'measured_position_fraction',
    'tracked_or_explained_fraction',
    'body_area_px',
    'longest_gap_frames',
    'longest_gap_start_frame',
    'platform_diameter_cm',
    'platform_diameter_set_by',
    'px_per_cm',
    'hole_count',
    'warnings',
    'analyzed_at',
    'tool_version',
    'parameter_fingerprint',
    'result_settings_fingerprint',
  ];

  const rows = inputs.map((i) => {
    const m = i.measures;
    const hasTarget = i.geometry.targetHoleIndex !== null;
    const q = m.quality;
    const f = m.strategy.features;
    return [
      i.videoId,
      i.fileName,
      i.trackingSource,
      i.observationToolVersion,
      measurementFingerprint(i.measurementBasis),
      i.resultStatus,
      i.provisionalReasons.join(' | '),
      ...metadataValues(i.meta),
      i.geometry.targetHoleIndex === null ? null : holeNumber(i.geometry, i.geometry.targetHoleIndex),
      i.geometry.targetProvenance,
      i.trialStartFrame,
      round(frameTime(i.timebase, i.trialStartFrame), 3),
      i.trialStartReason,
      round(m.trialDurationSec, 3),
      hasTarget ? round(m.primaryLatency.sec, 3) : null,
      hasTarget ? m.primaryLatency.observed : null,
      hasTarget ? m.primaryLatency.frame : null,
      hasTarget ? m.primaryLatency.provenance : null,
      hasTarget ? round(m.totalLatency.sec, 3) : null,
      hasTarget ? m.totalLatency.observed : null,
      hasTarget ? m.totalLatency.frame : null,
      hasTarget ? m.totalLatency.provenance : null,
      hasTarget && m.primaryErrorCoverage > 0 ? m.primaryErrors : null,
      hasTarget ? m.primaryErrorCoverage === 1 : null,
      hasTarget ? round(m.primaryErrorCoverage, 4) : null,
      hasTarget && m.totalErrorCoverage > 0 ? m.totalErrors : null,
      hasTarget ? m.totalErrorCoverage === 1 : null,
      hasTarget ? round(m.totalErrorCoverage, 4) : null,
      round(m.pathLengthCm, 1),
      round(m.pathLengthCoverage, 4),
      round(m.meanSpeedCmPerSec, 2),
      round(m.meanMovingSpeedCmPerSec, 2),
      round(m.maxSpeedCmPerSec, 2),
      hasTarget ? round(m.timeInTargetQuadrantSec, 2) : null,
      hasTarget ? round(m.targetQuadrantFraction, 4) : null,
      hasTarget ? round(m.targetQuadrantCoverage, 4) : null,
      i.strategyOverride?.strategy ?? m.strategy.strategy,
      m.strategy.strategy,
      m.strategy.rule,
      i.strategyOverride ? 'manual' : m.strategy.provenance,
      i.strategyOverride?.reason ?? null,
      round(f.pathEfficiency, 4),
      round(f.pathCoverage, 4),
      f.holesBeforeTarget,
      f.longestSerialRun,
      f.centerCrossings,
      round(f.peripheryFraction, 4),
      round(f.meanTurnRateDegPerSec, 1),
      round(f.startDistanceCm, 1),
      q.frameCount,
      q.trackedFrames,
      q.partialFrames,
      q.inHoleFrames,
      q.lostFrames,
      q.preTrialFrames,
      q.manuallyEditedFrames,
      q.measuredPositionFrames,
      round(q.measuredPositionFraction, 4),
      round(q.trackedFraction, 4),
      q.bodyAreaPx > 0 ? round(q.bodyAreaPx, 0) : null,
      q.longestGapFrames,
      q.longestGapStart,
      i.geometry.platformDiameterCm,
      i.geometry.platformDiameterSource,
      round((2 * i.geometry.platformRadiusPx) / i.geometry.platformDiameterCm, 4),
      i.geometry.holeCount,
      uniqueWarnings(i.warnings).join(' | '),
      i.analyzedAt,
      TOOL_VERSION,
      parameterFingerprint(i.params),
      settingsFingerprint(i.params, resultSettings(i)),
    ];
  });

  return {
    name: 'Trial summary',
    columns,
    rows,
    description:
      'One row per supplied trial. The app exports only reportable rows; regression fixtures may include rows explicitly marked provisional. observed=FALSE marks a censored cutoff, not a measured latency.',
  };
}

/**
 * One row per event, so a disagreement can be traced to the frame it came from.
 */
export function eventDetailTable(inputs: ReadonlyArray<ExportInput>): Table {
  const columns = [
    'video_id',
    'video_file',
    'tracking_source',
    'result_status',
    'provisional_reasons',
    'observation_tool_version',
    'measurement_fingerprint',
    ...METADATA_COLUMNS,
    'event_id',
    'event_type',
    'hole',
    'is_target_hole',
    'counted_as_error',
    'start_frame',
    'end_frame',
    'start_seconds',
    'end_seconds',
    'duration_s',
    'seconds_from_trial_start',
    'min_nose_distance_cm',
    'min_visible_area_fraction',
    'set_by',
    'evidence',
    'analyzed_at',
    'tool_version',
    'parameter_fingerprint',
    'result_settings_fingerprint',
  ];

  const rows: (string | number | boolean | null)[][] = [];
  for (const i of inputs) {
    const startSec = frameTime(i.timebase, i.trialStartFrame);
    for (const e of [...i.events].sort((a, b) => a.startFrame - b.startFrame)) {
      const s = frameTime(i.timebase, e.startFrame);
      const en = frameEndTime(i.timebase, e.endFrame);
      rows.push([
        i.videoId,
        i.fileName,
        i.trackingSource,
        i.resultStatus,
        i.provisionalReasons.join(' | '),
        i.observationToolVersion,
        measurementFingerprint(i.measurementBasis),
        ...metadataValues(i.meta),
        e.id,
        e.type,
        holeNumber(i.geometry, e.holeIndex),
        e.isTarget,
        e.isError,
        e.startFrame,
        e.endFrame,
        round(s, 3),
        round(en, 3),
        round(en - s, 3),
        round(s - startSec, 3),
        round(e.minNoseDistanceCm, 2),
        round(e.minAreaRatio, 3),
        e.provenance,
        e.evidence,
        i.analyzedAt,
        TOOL_VERSION,
        parameterFingerprint(i.params),
        settingsFingerprint(i.params, resultSettings(i)),
      ]);
    }
  }

  return {
    name: 'Events',
    columns,
    rows,
    description:
      'One row per hole investigation or entry, with frame range and evidence.',
  };
}

/** One row per frame for detailed review. */
export function frameDetailTable(input: ExportInput): Table {
  const columns = [
    'video_id',
    'video_file',
    'tracking_source',
    'result_status',
    'provisional_reasons',
    'frame',
    'seconds',
    'seconds_from_trial_start',
    'status',
    'position_source',
    'body_x_px',
    'body_y_px',
    'nose_x_px',
    'nose_y_px',
    'body_x_cm',
    'body_y_cm',
    'visible_area_px',
    'visible_area_measured',
    'hole',
    'confidence',
    'interpolated',
    'set_by',
    'status_set_by',
    'body_set_by',
    'nose_set_by',
  ];
  const scale = (2 * input.geometry.platformRadiusPx) / input.geometry.platformDiameterCm;
  const startSec = frameTime(input.timebase, input.trialStartFrame);
  const cx = input.geometry.center.x;
  const cy = input.geometry.center.y;

  const rows = input.frames.map((f) => {
    const t = frameTime(input.timebase, f.frame);
    return [
      input.videoId,
      input.fileName,
      input.trackingSource,
      input.resultStatus,
      input.provisionalReasons.join(' | '),
      f.frame,
      round(t, 4),
      round(t - startSec, 4),
      f.status,
      positionSource(f),
      f.body ? round(f.body.x, 2) : null,
      f.body ? round(f.body.y, 2) : null,
      f.nose ? round(f.nose.x, 2) : null,
      f.nose ? round(f.nose.y, 2) : null,
      // Centered on the platform and in centimeters, which is the frame of
      // reference a reader can reason about without knowing the camera.
      f.body ? round((f.body.x - cx) / scale, 3) : null,
      f.body ? round((f.body.y - cy) / scale, 3) : null,
      f.areaMeasured ? f.areaPx : null,
      f.areaMeasured,
      f.holeIndex === null ? null : holeNumber(input.geometry, f.holeIndex),
      round(f.confidence, 3),
      f.interpolated,
      f.provenance,
      f.statusProvenance,
      f.bodyProvenance,
      f.noseProvenance,
    ];
  });

  return {
    name: 'Frames',
    columns,
    rows,
    description:
      'One row per frame. Centimeter coordinates use the platform center as origin. Field-specific provenance identifies each human edit.',
  };
}

/** The quality report, as a table rather than prose, so it can be filtered. */
export function qualityTable(inputs: ReadonlyArray<ExportInput>): Table {
  const columns = [
    'video_id',
    'video_file',
    'tracking_source',
    'result_status',
    'provisional_reasons',
    'measured_position_fraction',
    'tracked_or_explained_fraction',
    'frames_manually_edited',
    'issue_type',
    'start_frame',
    'end_frame',
    'duration_s',
    'hole',
    'verdict',
    'explanation',
    'observation_tool_version',
    'measurement_fingerprint',
    'analyzed_at',
    'tool_version',
    'parameter_fingerprint',
    'result_settings_fingerprint',
  ];
  const rows: (string | number | boolean | null)[][] = [];
  for (const i of inputs) {
    const q = i.measures.quality;
    const warnings = uniqueWarnings(i.warnings);
    const provenance = [
      i.observationToolVersion,
      measurementFingerprint(i.measurementBasis),
      i.analyzedAt,
      TOOL_VERSION,
      parameterFingerprint(i.params),
      settingsFingerprint(i.params, resultSettings(i)),
    ] as const;
    const base = [
      i.videoId,
      i.fileName,
      i.trackingSource,
      i.resultStatus,
      i.provisionalReasons.join(' | '),
      round(q.measuredPositionFraction, 4),
      round(q.trackedFraction, 4),
      q.manuallyEditedFrames,
    ] as const;
    const needsReview = i.gaps.some((gap) => gap.verdict === 'lost') || warnings.length > 0;
    rows.push([
      ...base,
      'summary',
      null,
      null,
      null,
      null,
      needsReview ? 'review' : 'ok',
      needsReview ? 'See issue rows for this recording.' : 'No analysis warning was detected.',
      ...provenance,
    ]);
    for (const g of i.gaps) {
      rows.push([
        ...base,
        'absence',
        g.startFrame,
        g.endFrame,
        round(g.durationSec, 3),
        g.holeIndex === null ? null : holeNumber(i.geometry, g.holeIndex),
        g.verdict,
        g.explanation,
        ...provenance,
      ]);
    }
    for (const warning of warnings) {
      rows.push([...base, 'analysis_warning', null, null, null, null, null, warning, ...provenance]);
    }
  }
  return {
    name: 'Quality',
    columns,
    rows,
    description:
      'One summary row per recording, followed by tracking gaps and analysis warnings.',
  };
}

function uniqueWarnings(warnings: ReadonlyArray<string>): string[] {
  return [...new Set(warnings.filter((warning) => warning.trim().length > 0))];
}

export interface ExcludedRecordingRow {
  readonly id: string;
  readonly fileName: string;
  readonly reason: string;
}

/** Recordings intentionally absent from reportable result tables. */
export function exclusionsTable(rows: ReadonlyArray<ExcludedRecordingRow>): Table {
  return {
    name: 'Exclusions',
    columns: ['video_id', 'video_file', 'excluded_from', 'reason'],
    rows: rows.map((row) => [row.id, row.fileName, 'reportable results', row.reason]),
    description: 'One row per recording excluded from reportable result tables.',
  };
}

/**
 * Every parameter, in a table, so a reader can see what produced the numbers.
 */
/** Only measurement settings belong in the result fingerprint. */
export function resultSettings(input: ExportInput) {
  const { geometry, trialStartFrame, trackingSource, observationToolVersion, measurementBasis } = input;
  return { geometry, trialStartFrame, trackingSource, observationToolVersion, measurementBasis };
}

/** One row of the parameters table: a recording and the settings its result depends on. */
export function recordingSettings(input: ExportInput): RecordingGeometry {
  return { recording: input.fileName, ...resultSettings(input) };
}

export interface RecordingGeometry {
  readonly recording: string;
  readonly geometry: MazeGeometry;
  readonly trackingSource: TrackingSource;
  readonly observationToolVersion: string | null;
  readonly measurementBasis: MeasurementBasis | null;
  readonly trialStartFrame: number;
}

export function parametersTable(
  params: AnalysisParams,
  geometries: ReadonlyArray<RecordingGeometry>,
  protocol?: ProtocolPreset | null,
): Table {
  const rows: (string | number | boolean | null)[][] = [];
  const add = (group: string, name: string, value: unknown, unit: string, note: string) =>
    rows.push([group, name, value as string | number | boolean | null, unit, note]);

  if (protocol) {
    add('Protocol', 'name', protocol.name, '', 'User-supplied lab protocol; not proof of approval.');
    add('Protocol', 'revision', protocol.revision, '', 'Revision declared in the imported or saved protocol.');
    add('Protocol', 'original_parameters', JSON.stringify(protocol.params), '', 'Baseline definitions before session edits.');
    add('Protocol', 'modified', parameterFingerprint(params) !== parameterFingerprint(protocol.params), '', 'Compare with the current parameters below.');
  }

  const diameters = [...new Set(geometries.map((item) => item.geometry.platformDiameterCm))];
  const scaleSources = [...new Set(geometries.map((item) => item.geometry.platformDiameterSource))];
  const oneDiameter = diameters.length === 1 ? diameters[0]! : null;
  const oneScaleSource = scaleSources.length === 1 ? scaleSources[0]! : null;

  add('Scale', 'platform_diameter_cm', oneDiameter, 'cm',
    diameters.length > 1
      ? 'Varies by recording. See platform_diameter_cm in Trial summary.'
      : 'All centimeter measures use this scale.');
  add(
    'Scale',
    'platform_diameter_set_by',
    oneScaleSource ?? (scaleSources.length > 1 ? 'varies by recording' : null),
    '',
    'default is an unconfirmed estimate and is not reportable.',
  );
  add('Tracking', 'dark_threshold', params.tracking.darkThreshold, 'gray levels',
    'How much darker than the empty platform a pixel must be to count as animal.');
  add('Tracking', 'min_blob_px', params.tracking.minBlobPx, 'px', 'Noise floor.');
  add('Tracking', 'max_area_ratio', params.tracking.maxAreaRatio, 'x body area',
    'Excludes larger objects such as a cylinder, hand, or shadow.');
  add('Tracking', 'partial_area_ratio', params.tracking.partialAreaRatio, 'x body area',
    'Below this, an animal centered on a hole is recorded as partly inside it.');
  add('Tracking', 'body_core_erode_px', params.tracking.bodyCoreErodePx, 'px',
    'Erosion depth used to strip the tail before finding the body axis.');
  add('Tracking', 'hole_lock_radius_px', params.tracking.holeLockRadiusPx, 'px',
    'Maximum distance used when classifying a disappearance at a hole.');
  add('Tracking', 'background_sample_frames', params.tracking.backgroundSampleFrames, 'frames',
    'Frames used to build the empty-platform reference image.');
  add('Events', 'investigation_radius_cm', params.events.investigationRadiusCm, 'cm',
    'Nose within this distance of a hole center counts as investigating it.');
  add('Events', 'min_investigation_s', params.events.minInvestigationSec, 's',
    'Minimum dwell. Raising it discards fly-pasts.');
  add('Events', 'merge_gap_s', params.events.mergeGapSec, 's',
    'Returning to the same hole within this long counts as one visit.');
  add('Events', 'exit_radius_multiple', params.events.exitRadiusMultiple, 'x radius',
    'Distance required to end a visit.');
  add('Events', 'entry_area_ratio', params.events.entryAreaRatio, 'x body area',
    'Visible area must fall below this to call an entry rather than an investigation.');
  add('Events', 'min_entry_s', params.events.minEntrySec, 's', 'How long it must stay there.');
  add('Events', 'error_counting', params.events.errorCounting, '',
    'unique counts each wrong hole once; all counts every visit.');
  add('Events', 'adjacent_holes_are_errors', params.events.adjacentHolesAreErrors, '',
    'Whether the two holes either side of the target count as errors.');
  add('Trial', 'trial_cutoff_s', params.trialCutoffSec, 's',
    'Events and measures stop here; undetected latencies are censored.');
  add('Trial', 'center_zone_fraction', params.centerZoneFraction, 'x radius', 'What counts as the middle.');
  add('Trial', 'moving_speed_threshold_cm_s', params.movingSpeedThresholdCmPerSec, 'cm/s',
    'Below this the animal is not moving.');
  add('Trial', 'speed_window_s', params.speedWindowSec, 's',
    'Time window used for speed.');
  add('Cleanup', 'max_interpolate_gap_frames', params.maxInterpolateGapFrames, 'frames',
    'Gaps up to this long may be bridged; longer ones stay gaps.');
  add('Cleanup', 'smoothing_window_frames', params.smoothingWindowFrames, 'frames',
    'Median filter width. 1 disables it.');
  add('Strategy', 'spatial_min_efficiency', params.strategy.spatialMinEfficiency, '',
    'Path efficiency needed to call a trial spatial.');
  add('Strategy', 'spatial_max_holes_before_target', params.strategy.spatialMaxHolesBeforeTarget, 'holes', '');
  add('Strategy', 'serial_min_run', params.strategy.serialMinRun, 'holes',
    'Consecutive holes in one direction needed to call a trial serial.');
  add('Strategy', 'serial_min_periphery_fraction', params.strategy.serialMinPeripheryFraction, '',
    'A serial search hugs the rim.');
  add('Strategy', 'random_min_center_crossings', params.strategy.randomMinCenterCrossings, 'crossings', '');
  add('Version', 'tool_version', TOOL_VERSION, '', '');
  add('Version', 'parameter_fingerprint', parameterFingerprint(params), '',
    'Hash of analysis parameters.');
  add(
    'Version',
    'result_settings_fingerprint',
    geometries.length === 0
      ? null
      : geometries.length === 1
        ? settingsFingerprint(params, {
            geometry: geometries[0]!.geometry,
            trialStartFrame: geometries[0]!.trialStartFrame,
            trackingSource: geometries[0]!.trackingSource,
            observationToolVersion: geometries[0]!.observationToolVersion,
            measurementBasis: geometries[0]!.measurementBasis,
          })
        : settingsFingerprint(
            params,
            geometries.map((item) => ({
              recording: item.recording,
              geometry: item.geometry,
              trialStartFrame: item.trialStartFrame,
              trackingSource: item.trackingSource,
              observationToolVersion: item.observationToolVersion,
              measurementBasis: item.measurementBasis,
            })),
          ),
    '',
    'Hash of parameters, geometry, trial start, tracking source, pixel-measurement basis, and observation version.',
  );

  return {
    name: 'Parameters',
    columns: ['group', 'parameter', 'value', 'unit', 'what it does'],
    rows,
    description: 'The settings that produced these numbers.',
  };
}

/**
 * A short, stable hash of the parameters.
 *
 * Not for security — for the conversation that starts "these two cohorts
 * disagree". Same fingerprint means same settings, and it is short enough to
 * read out loud.
 */
export function parameterFingerprint(params: AnalysisParams): string {
  return shortFingerprint(params);
}

/** Stable identity for the pixel measurements used by one recording. */
export function measurementFingerprint(basis: MeasurementBasis | null): string {
  return basis ? shortFingerprint(basis) : 'unavailable';
}

/**
 * Hash the settings that can change numerical results, including physical
 * scale and observation provenance.
 */
export function settingsFingerprint(
  params: AnalysisParams,
  resultSettings:
    | {
        readonly geometry: MazeGeometry;
        readonly trialStartFrame: number;
        readonly trackingSource: TrackingSource;
        readonly observationToolVersion: string | null;
        readonly measurementBasis: MeasurementBasis | null;
      }
    | ReadonlyArray<{
        readonly recording: string;
        readonly geometry: MazeGeometry;
        readonly trialStartFrame: number;
        readonly trackingSource: TrackingSource;
        readonly observationToolVersion: string | null;
        readonly measurementBasis: MeasurementBasis | null;
      }>,
): string {
  const normalized = Array.isArray(resultSettings)
    ? [...resultSettings]
        .sort((a, b) => a.recording.localeCompare(b.recording))
        .map((item) => ({ ...item, geometry: resultGeometryBasis(item.geometry) }))
    : {
        ...(resultSettings as {
          readonly geometry: MazeGeometry;
          readonly trialStartFrame: number;
          readonly trackingSource: TrackingSource;
          readonly observationToolVersion: string | null;
          readonly measurementBasis: MeasurementBasis | null;
        }),
        geometry: resultGeometryBasis(
          (resultSettings as { readonly geometry: MazeGeometry }).geometry,
        ),
      };
  return shortFingerprint({ params, resultSettings: normalized });
}

/** Stable identity for the maze layout, excluding target, scale, and provenance. */
export function mazeLayoutFingerprint(geometry: MazeGeometry): string {
  return shortFingerprint({
    center: geometry.center,
    platformRadiusPx: geometry.platformRadiusPx,
    ringRadiusPx: geometry.ringRadiusPx,
    phaseRad: geometry.phaseRad,
    holeCount: geometry.holeCount,
    holes: [...geometry.holes]
      .sort((a, b) => a.index - b.index)
      .map(({ index, center, radiusPx }) => ({ index, center, radiusPx })),
  });
}

function resultGeometryBasis(geometry: MazeGeometry): unknown {
  return {
    layout: mazeLayoutFingerprint(geometry),
    targetHoleIndex: geometry.targetHoleIndex,
    platformDiameterCm: geometry.platformDiameterCm,
  };
}

function shortFingerprint(value: unknown): string {
  const text = JSON.stringify(canonicalize(value));
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = ((h1 ^ c) * 0x01000193) >>> 0;
    h2 = ((h2 + c) * 0x85ebca6b) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 10);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

/** Exports write a missing value as an empty cell, never as NaN. */
function round(v: number, digits: number): number | null {
  return Number.isFinite(v) ? roundTo(v, digits) : null;
}

/** Recording metadata, each value followed by who set it. Same columns in every table. */
const METADATA_COLUMNS = ['animal_id', 'animal_id_set_by', 'group', 'group_set_by', 'day', 'day_set_by', 'trial', 'trial_set_by'] as const;

function metadataValues(meta: VideoMeta): (string | number | null)[] {
  return (['animalId', 'group', 'day', 'trial'] as const).flatMap((field) => [meta[field], metadataOrigin(meta, field)]);
}

function metadataOrigin(meta: VideoMeta, field: 'animalId' | 'group' | 'day' | 'trial'): 'filename' | 'manual' | 'blank' {
  const value = meta[field];
  if (value === null || value === '') return 'blank';
  return meta.parsedFromFilename.includes(field) ? 'filename' : 'manual';
}

function positionSource(
  frame: TrackFrame,
): 'automatic_tracking' | 'imported_pose' | 'manual' | 'interpolated' | 'inferred_hole_center' | 'unavailable' {
  if (!frame.body && !frame.nose) return 'unavailable';
  if (frame.status === 'inHole') return 'inferred_hole_center';
  if (frame.interpolated) return 'interpolated';
  if (frame.provenance === 'manual') return 'manual';
  return frame.provenance === 'imported' ? 'imported_pose' : 'automatic_tracking';
}
