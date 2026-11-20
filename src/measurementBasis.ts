import type {
  AnalysisParams,
  MazeGeometry,
  MeasurementBasis,
  MeasurementTrackingParams,
  TrackingSource,
} from './types';

export const MEASUREMENT_TRACKING_KEYS = [
  'darkThreshold',
  'minBlobPx',
  'maxAreaRatio',
  'bodyCoreErodePx',
  'backgroundSampleFrames',
] as const satisfies ReadonlyArray<keyof MeasurementTrackingParams>;

export function videoMeasurementBasis(params: AnalysisParams, geometry: MazeGeometry): MeasurementBasis {
  return {
    kind: 'video',
    tracking: {
      darkThreshold: params.tracking.darkThreshold,
      minBlobPx: params.tracking.minBlobPx,
      maxAreaRatio: params.tracking.maxAreaRatio,
      bodyCoreErodePx: params.tracking.bodyCoreErodePx,
      backgroundSampleFrames: params.tracking.backgroundSampleFrames,
    },
    platform: {
      center: { ...geometry.center },
      radiusPx: geometry.platformRadiusPx,
    },
  };
}

export function measurementBasisIssue(
  basis: MeasurementBasis | null,
  source: TrackingSource,
  params: AnalysisParams,
  geometry: MazeGeometry,
): string | null {
  if (source !== 'video') {
    return basis?.kind === 'imported-pose' ? null : 'imported track provenance unavailable';
  }
  if (!basis || basis.kind !== 'video') return 'tracking provenance unavailable; reanalyze recording';
  for (const key of MEASUREMENT_TRACKING_KEYS) {
    if (basis.tracking[key] !== params.tracking[key]) return 'tracking settings changed; reanalyze recording';
  }
  if (
    basis.platform.center.x !== geometry.center.x ||
    basis.platform.center.y !== geometry.center.y ||
    basis.platform.radiusPx !== geometry.platformRadiusPx
  ) {
    return 'maze outline changed; reanalyze recording';
  }
  return null;
}

export function measurementBasisErrors(value: unknown, source: TrackingSource): string[] {
  if (!value || typeof value !== 'object') return ['measurement basis is missing'];
  const basis = value as Record<string, unknown>;
  if (source !== 'video') return basis.kind === 'imported-pose' ? [] : ['imported measurement basis is invalid'];
  if (basis.kind !== 'video') return ['video measurement basis is invalid'];
  const tracking = basis.tracking as Partial<MeasurementTrackingParams> | undefined;
  const platform = basis.platform as { center?: { x?: unknown; y?: unknown }; radiusPx?: unknown } | undefined;
  const errors: string[] = [];
  if (!finiteInRange(tracking?.darkThreshold, 0, 255)) errors.push('measurement setting darkThreshold is invalid');
  if (!integerAtLeast(tracking?.minBlobPx, 1)) errors.push('measurement setting minBlobPx is invalid');
  if (!finiteAbove(tracking?.maxAreaRatio, 1)) errors.push('measurement setting maxAreaRatio is invalid');
  if (!integerAtLeast(tracking?.bodyCoreErodePx, 0)) errors.push('measurement setting bodyCoreErodePx is invalid');
  if (!integerAtLeast(tracking?.backgroundSampleFrames, 3)) {
    errors.push('measurement setting backgroundSampleFrames is invalid');
  }
  if (
    typeof platform?.center?.x !== 'number' ||
    !Number.isFinite(platform.center.x) ||
    typeof platform?.center?.y !== 'number' ||
    !Number.isFinite(platform.center.y) ||
    typeof platform.radiusPx !== 'number' ||
    !Number.isFinite(platform.radiusPx) ||
    platform.radiusPx <= 0
  ) {
    errors.push('measurement platform is invalid');
  }
  return errors;
}

function finiteInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function finiteAbove(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > minimum;
}

function integerAtLeast(value: unknown, minimum: number): value is number {
  return Number.isInteger(value) && (value as number) >= minimum;
}
