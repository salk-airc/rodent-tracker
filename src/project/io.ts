/** Read, validate, and write the current project format. */

import { analysisParameterErrors } from '../params';
import { parseProtocol } from './protocol';
import { isVideoHash } from './identity';
import { measurementBasisErrors } from '../measurementBasis';
import type { FrameStatus, MazeGeometry, Point, Provenance, SearchStrategy, TrialStart } from '../types';
import type { ManualCorrection } from '../tracking/resolve';
import { PROJECT_FORMAT_VERSION, TOOL_VERSION, type PackedObservations, type ProjectFile, type StoredVideo } from './schema';

export class ProjectFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectFormatError';
  }
}

export function writeProject(
  project: Omit<ProjectFile, 'format' | 'formatVersion' | 'toolVersion' | 'updatedAt'>,
  options: { readonly updatedAt?: string } = {},
): string {
  const file: ProjectFile = {
    format: 'barnes-maze-analyzer',
    formatVersion: PROJECT_FORMAT_VERSION,
    toolVersion: TOOL_VERSION,
    updatedAt: options.updatedAt ?? new Date().toISOString(),
    ...project,
  };
  return collapseNumericArrays(JSON.stringify(file, null, 2));
}

/**
 * Put arrays of plain numbers back onto one line.
 *
 * Indented JSON is what makes this file readable by a person, and readable by a
 * person is a stated goal: the format is meant to be inspectable without this
 * tool. But indenting puts every element of every per-frame column on its own
 * line, which took a three-minute recording from a couple of hundred kilobytes
 * to two megabytes of mostly whitespace.
 *
 * The substitution is safe because it only ever matches arrays whose every
 * element is a number: numbers cannot contain a bracket, a quote or a comma, so
 * there is no string or nested structure for the pattern to run past.
 */
function collapseNumericArrays(json: string): string {
  return json.replace(/\[\s*\n\s*(-?\d[\d.eE+-]*(?:,\s*\n\s*-?\d[\d.eE+-]*)*)\s*\n\s*\]/g, (_, body: string) =>
    `[${body.replace(/\s*\n\s*/g, ' ')}]`,
  );
}

export function readProject(text: string): ProjectFile {
  const p = parseProjectObject(text);

  if (p.format !== 'barnes-maze-analyzer') {
    throw new ProjectFormatError(
      'This does not look like a Barnes Maze Analyzer project file.',
    );
  }
  if (typeof p.formatVersion !== 'number' || !Number.isInteger(p.formatVersion) || p.formatVersion < 1) {
    throw new ProjectFormatError('This project file does not say which format version it is.');
  }
  if (p.formatVersion !== PROJECT_FORMAT_VERSION) {
    throw new ProjectFormatError(
      `Project uses unsupported format version ${p.formatVersion}. This build requires version ${PROJECT_FORMAT_VERSION}.`,
    );
  }
  if (!Array.isArray(p.videos)) {
    throw new ProjectFormatError('This project file has no list of videos in it.');
  }
  if (!Array.isArray(p.excludedVideos)) {
    throw new ProjectFormatError('This project file has no excluded-recording manifest.');
  }
  if (!p.params) {
    throw new ProjectFormatError(
      'This project has no analysis parameters. Results cannot be reproduced.',
    );
  }

  const parameterErrors = analysisParameterErrors(p.params);
  if (parameterErrors.length) {
    throw new ProjectFormatError(`This project has invalid analysis parameters: ${parameterErrors.join('; ')}.`);
  }
  if (!p.project || typeof p.project.name !== 'string') {
    throw new ProjectFormatError('This project file has incomplete project metadata.');
  }
  if (p.project.protocol != null) {
    try { parseProtocol(p.project.protocol); }
    catch (error) { throw new ProjectFormatError((error as Error).message); }
  }
  if (!Array.isArray(p.rigs)) {
    throw new ProjectFormatError('This project file has no rig-template list.');
  }
  if (typeof p.createdAt !== 'string' || typeof p.updatedAt !== 'string' || typeof p.toolVersion !== 'string') {
    throw new ProjectFormatError('This project file has incomplete provenance metadata.');
  }
  validTimestamp(p.createdAt, 'The project creation timestamp');
  validTimestamp(p.updatedAt, 'The project update timestamp');

  const videoIds = validateProjectVideos(p.videos);
  validateExcludedVideos(p.excludedVideos, videoIds);
  const rigIds = validateRigTemplates(p.rigs);

  for (const v of p.videos) {
    if (v.rigId !== null && !rigIds.has(v.rigId)) {
      throw new ProjectFormatError(`"${v.fileName}" refers to a rig template that is not in this project.`);
    }
  }

  return p as ProjectFile;
}

function parseProjectObject(text: string): Partial<ProjectFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ProjectFormatError(
      `Invalid project JSON: ${(e as Error).message}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ProjectFormatError('This file does not contain a project.');
  }
  return parsed as Partial<ProjectFile>;
}

// A host app's reference to the recording: any plain JSON object.
function invalidSource(source: unknown): boolean {
  if (source == null) return false;
  return typeof source !== 'object' || Array.isArray(source);
}

function validateProjectVideos(videos: readonly StoredVideo[]): Set<string> {
  const videoIds = new Set<string>();

  for (const [i, v] of videos.entries()) {
    const where = v?.fileName ? `"${v.fileName}"` : `video ${i + 1}`;
    if (!v || typeof v.id !== 'string' || !v.id || typeof v.fileName !== 'string' || !v.fileName) {
      throw new ProjectFormatError(`${where} has incomplete recording identity.`);
    }
    if (videoIds.has(v.id)) throw new ProjectFormatError(`${where} repeats recording id "${v.id}".`);
    videoIds.add(v.id);
    validateVideoMetadata(v, where);
    if (v.sourceSha256 != null && !isVideoHash(v.sourceSha256)) {
      throw new ProjectFormatError(`${where} has an invalid source-video SHA-256.`);
    }
    if (invalidSource(v.source)) throw new ProjectFormatError(`${where} has an invalid source reference.`);

    if (!v.observations || !Number.isInteger(v.observations.count) || v.observations.count <= 0) {
      throw new ProjectFormatError(`${where} has no tracking data in it.`);
    }
    validatePackedObservations(v.observations, where);
    if (!Number.isInteger(v.timebase?.timescale) || v.timebase.timescale <= 0 || !v.timebase.ptsTicks?.length) {
      throw new ProjectFormatError(`${where} has no frame timing.`);
    }
    if (v.timebase.ptsTicks.length !== v.observations.count) {
      throw new ProjectFormatError(`${where} has different numbers of timestamps and tracking frames.`);
    }
    validateTimestamps(v.timebase.ptsTicks, where);
    validateGeometry(v.geometry, where);
    validateObservationSemantics(v, where);
    validateTrialStart(v.detectedTrialStart, v.observations.count, `${where}'s detected trial start`);
    if (v.detectedTrialStart.reason === 'manual' || v.detectedTrialStart.provenance !== 'auto') {
      throw new ProjectFormatError(`${where}'s detected trial start is not an automatic detection.`);
    }
    if (v.trialStartOverride !== null) {
      validateTrialStart(v.trialStartOverride, v.observations.count, `${where}'s trial-start correction`);
      if (v.trialStartOverride.reason !== 'manual' || v.trialStartOverride.provenance !== 'manual') {
        throw new ProjectFormatError(`${where}'s trial-start correction is not identified as a human edit.`);
      }
    }
    validateCorrections(v.corrections, v, where);
  }
  return videoIds;
}

function validateExcludedVideos(excludedVideos: ProjectFile['excludedVideos'], videoIds: Set<string>): void {
  for (const [index, video] of excludedVideos.entries()) {
    const where = video?.fileName ? `"${video.fileName}"` : `excluded recording ${index + 1}`;
    if (
      !video ||
      typeof video.id !== 'string' ||
      !video.id ||
      typeof video.fileName !== 'string' ||
      !video.fileName ||
      videoIds.has(video.id) ||
      (video.fileSize !== null && (!Number.isInteger(video.fileSize) || video.fileSize < 0)) ||
      (video.status !== 'queued' && video.status !== 'failed') ||
      (video.error !== null && typeof video.error !== 'string') ||
      invalidSource(video.source)
    ) {
      throw new ProjectFormatError(`${where} has invalid or repeated excluded-recording metadata.`);
    }
    videoIds.add(video.id);
  }
}

function validateRigTemplates(rigs: ProjectFile['rigs']): Set<string> {
  const rigIds = new Set<string>();
  for (const [i, rig] of rigs.entries()) {
    const where = `rig template ${i + 1}`;
    if (!rig || typeof rig.id !== 'string' || !rig.id || rigIds.has(rig.id)) {
      throw new ProjectFormatError(`${where} has a missing or repeated id.`);
    }
    rigIds.add(rig.id);
    if (typeof rig.name !== 'string' || !Number.isInteger(rig.holeCount) || rig.holeCount <= 0) {
      throw new ProjectFormatError(`${where} is incomplete.`);
    }
    finitePositive(rig.platformDiameterCm, `${where}'s platform diameter`);
    finitePoint(rig.reference?.center, `${where}'s reference center`);
    finitePositive(rig.reference?.platformRadiusPx, `${where}'s reference platform radius`);
    finitePositive(rig.reference?.ringRadiusFraction, `${where}'s reference ring-radius fraction`);
    finiteNumber(rig.reference?.phaseRad, `${where}'s reference phase`);
    if (rig.targetHoleIndex !== null &&
        (!Number.isInteger(rig.targetHoleIndex) || rig.targetHoleIndex < 0 || rig.targetHoleIndex >= rig.holeCount)) {
      throw new ProjectFormatError(`${where} names an escape hole outside its hole ring.`);
    }
    validNumbering(rig, where);
  }
  return rigIds;
}

const REQUIRED_OBSERVATION_COLUMNS: ReadonlyArray<Exclude<keyof PackedObservations, 'count'>> = [
  'frame',
  'areaMeasured',
  'areaPx',
  'darkPixelsPx',
  'bodyX',
  'bodyY',
  'noseX',
  'noseY',
  'tailX',
  'tailY',
  'thicknessPx',
  'noseArmPx',
  'tailArmPx',
  'nearestHole',
  'nearestHoleDistPx',
  'radialFraction',
  'candidateCount',
  'reacquired',
  'axisConfidence',
];

function validatePackedObservations(observations: PackedObservations, where: string): void {
  for (const column of REQUIRED_OBSERVATION_COLUMNS) {
    validateNumericColumn(observations[column], observations.count, column, where);
  }
  if (observations.areaMeasured.some((value) => value !== 0 && value !== 1)) {
    throw new ProjectFormatError(`${where}'s areaMeasured column must contain only 0 or 1.`);
  }
  if (observations.reacquired.some((value) => value !== 0 && value !== 1)) {
    throw new ProjectFormatError(`${where}'s reacquired column must contain only 0 or 1.`);
  }
  if (observations.frame.some((value, index) => value !== index)) {
    throw new ProjectFormatError(`${where}'s frame column is not the complete ordered frame sequence.`);
  }
  for (const [xName, yName] of [
    ['bodyX', 'bodyY'],
    ['noseX', 'noseY'],
    ['tailX', 'tailY'],
  ] as const) {
    const xs = observations[xName];
    const ys = observations[yName];
    if (xs.some((x, index) => (x === -2147483648) !== (ys[index] === -2147483648))) {
      throw new ProjectFormatError(`${where}'s ${xName}/${yName} columns disagree about which positions are missing.`);
    }
  }
  if (observations.areaPx.some((value) => value < 0) || observations.darkPixelsPx.some((value) => value < 0)) {
    throw new ProjectFormatError(`${where}'s visible-area columns contain a negative measurement.`);
  }
  if (observations.candidateCount.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new ProjectFormatError(`${where}'s candidateCount column must contain non-negative integers.`);
  }
  if (observations.axisConfidence.some((value) => value < 0 || value > 1)) {
    throw new ProjectFormatError(`${where}'s axisConfidence column contains a value outside 0 to 1.`);
  }
  for (const [name, values] of [
    ['thicknessPx', observations.thicknessPx],
    ['noseArmPx', observations.noseArmPx],
    ['tailArmPx', observations.tailArmPx],
  ] as const) {
    if (values.some((value) => value < 0)) throw new ProjectFormatError(`${where}'s ${name} column contains a negative length.`);
  }
  if (observations.nearestHoleDistPx.some((value) => value < 0 && value !== -2147483648)) {
    throw new ProjectFormatError(`${where}'s nearestHoleDistPx column contains an invalid negative distance.`);
  }
  if (observations.radialFraction.some((value) => value < 0 && value !== -2147483648)) {
    throw new ProjectFormatError(`${where}'s radialFraction column contains an invalid negative radius fraction.`);
  }
}

function validateNumericColumn(values: unknown, count: number, column: string, where: string): asserts values is number[] {
  if (!Array.isArray(values) || values.length !== count) {
    throw new ProjectFormatError(
      `${where} says it has ${count} frames of tracking, but its ${column} column carries ` +
        `${Array.isArray(values) ? values.length : 0}. The file is truncated or corrupted.`,
    );
  }
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new ProjectFormatError(`${where}'s ${column} column contains a value that is not a finite number.`);
  }
}

function validateTimestamps(ticks: ReadonlyArray<number>, where: string): void {
  for (let i = 0; i < ticks.length; i++) {
    const value = ticks[i]!;
    if (!Number.isInteger(value)) throw new ProjectFormatError(`${where} has a timestamp that is not an integer container tick.`);
    if (i > 0 && value < ticks[i - 1]!) {
      throw new ProjectFormatError(`${where}'s presentation timestamps run backwards at frame ${i}.`);
    }
  }
}

function validateObservationSemantics(video: StoredVideo, where: string): void {
  if (video.observations.nearestHole.some(
    (value) => !Number.isInteger(value) || value < -1 || value >= video.geometry.holeCount,
  )) {
    throw new ProjectFormatError(`${where}'s nearestHole column refers to a hole outside the maze.`);
  }
  if (video.trackingSource === 'video') {
    if (!video.observationToolVersion) {
      throw new ProjectFormatError(`${where}'s native video tracking has no observation tool version.`);
    }
    if (video.observations.areaMeasured.some((value) => value !== 1)) {
      throw new ProjectFormatError(`${where}'s native video tracking is missing visible-area evidence.`);
    }
    return;
  }
  if (video.observationToolVersion !== null) {
    throw new ProjectFormatError(`${where}'s imported pose track cannot claim a native observation tool version.`);
  }
  if (
    video.bodyAreaPx !== 0 ||
    video.bodyAreaSpread !== 0 ||
    video.observations.areaMeasured.some((value) => value !== 0) ||
    video.observations.areaPx.some((value) => value !== 0) ||
    video.observations.darkPixelsPx.some((value) => value !== 0)
  ) {
    throw new ProjectFormatError(`${where}'s imported pose track contains unsupported video-area evidence.`);
  }
}

function validNumbering(
  value: Pick<MazeGeometry, 'holeCount' | 'holeOneIndex' | 'holeNumbering'>,
  where: string,
): void {
  const { holeOneIndex, holeNumbering, holeCount } = value;
  if (holeOneIndex !== undefined && (!Number.isInteger(holeOneIndex) || holeOneIndex < 0 || holeOneIndex >= holeCount)) {
    throw new ProjectFormatError(`${where} names a hole 1 outside its hole ring.`);
  }
  if (holeNumbering !== undefined && holeNumbering !== 'clockwise' && holeNumbering !== 'counterclockwise') {
    throw new ProjectFormatError(`${where}'s hole numbering direction is invalid.`);
  }
}

function validateGeometry(geometry: MazeGeometry | undefined, where: string): void {
  if (!geometry?.holes?.length) throw new ProjectFormatError(`${where} has no maze outline in it.`);
  if (!Number.isInteger(geometry.holeCount) || geometry.holeCount <= 0 || geometry.holes.length !== geometry.holeCount) {
    throw new ProjectFormatError(`${where} has an incomplete maze outline.`);
  }
  finitePoint(geometry.center, `${where}'s maze center`);
  finitePositive(geometry.platformRadiusPx, `${where}'s platform radius`);
  finitePositive(geometry.ringRadiusPx, `${where}'s hole-ring radius`);
  finiteNumber(geometry.phaseRad, `${where}'s hole-ring phase`);
  finitePositive(geometry.platformDiameterCm, `${where}'s platform diameter`);
  if (
    geometry.platformDiameterSource !== 'default' &&
    geometry.platformDiameterSource !== 'template' &&
    geometry.platformDiameterSource !== 'manual'
  ) {
    throw new ProjectFormatError(`${where}'s platform-diameter source is invalid.`);
  }
  validProvenance(geometry.provenance, `${where}'s maze provenance`);
  validProvenance(geometry.targetProvenance, `${where}'s escape-hole provenance`);
  if (geometry.targetHoleIndex !== null &&
      (!Number.isInteger(geometry.targetHoleIndex) || geometry.targetHoleIndex < 0 || geometry.targetHoleIndex >= geometry.holeCount)) {
    throw new ProjectFormatError(`${where} names an escape hole outside its hole ring.`);
  }
  validNumbering(geometry, where);
  const indices = new Set<number>();
  for (const hole of geometry.holes) {
    if (!Number.isInteger(hole.index) || hole.index < 0 || hole.index >= geometry.holeCount || indices.has(hole.index)) {
      throw new ProjectFormatError(`${where}'s maze has a missing, repeated, or out-of-range hole index.`);
    }
    indices.add(hole.index);
    finitePoint(hole.center, `${where}'s hole ${hole.index} center`);
    finitePositive(hole.radiusPx, `${where}'s hole ${hole.index} radius`);
    validProvenance(hole.provenance, `${where}'s hole ${hole.index} provenance`);
  }
  finiteNonNegative(geometry.fit?.platformResidualPx, `${where}'s platform-fit residual`);
  finiteFraction(geometry.fit?.ringSymmetry, `${where}'s ring symmetry`);
  finitePositive(geometry.fit?.ringRadiusFraction, `${where}'s ring-radius fraction`);
  if (!Array.isArray(geometry.fit?.warnings) || geometry.fit.warnings.some((warning) => typeof warning !== 'string')) {
    throw new ProjectFormatError(`${where}'s maze-fit warnings are malformed.`);
  }
}

function validateVideoMetadata(video: StoredVideo, where: string): void {
  if (!Number.isInteger(video.width) || video.width <= 0 || !Number.isInteger(video.height) || video.height <= 0) {
    throw new ProjectFormatError(`${where} has invalid video dimensions.`);
  }
  if (video.fileSize !== null && (!Number.isInteger(video.fileSize) || video.fileSize < 0)) {
    throw new ProjectFormatError(`${where} has an invalid file size.`);
  }
  if (video.analyzedAt !== null) validTimestamp(video.analyzedAt, `${where}'s analysis timestamp`);
  if (
    video.observationToolVersion !== null &&
    (typeof video.observationToolVersion !== 'string' || video.observationToolVersion.trim() === '')
  ) {
    throw new ProjectFormatError(`${where}'s observation tool version is invalid.`);
  }
  if (
    video.trackingSource !== 'video' &&
    video.trackingSource !== 'deeplabcut' &&
    video.trackingSource !== 'sleap-analysis-csv'
  ) {
    throw new ProjectFormatError(`${where}'s tracking source is invalid.`);
  }
  const basisErrors = measurementBasisErrors(video.measurementBasis, video.trackingSource);
  if (basisErrors.length > 0) {
    throw new ProjectFormatError(`${where} has invalid measurement provenance: ${basisErrors.join('; ')}.`);
  }
  finiteNonNegative(video.bodyAreaPx, `${where}'s learned body area`);
  finiteNonNegative(video.bodyAreaSpread, `${where}'s body-area spread`);
  if (!video.meta || typeof video.meta.animalId !== 'string' || typeof video.meta.group !== 'string' ||
      typeof video.meta.notes !== 'string' || !Array.isArray(video.meta.parsedFromFilename)) {
    throw new ProjectFormatError(`${where} has incomplete trial metadata.`);
  }
  const parsedFields = new Set(['animalId', 'group', 'day', 'trial']);
  if (video.meta.parsedFromFilename.some((field) => typeof field !== 'string' || !parsedFields.has(field))) {
    throw new ProjectFormatError(`${where} names an invalid filename-derived metadata field.`);
  }
  if (typeof video.mazeConfirmed !== 'boolean') {
    throw new ProjectFormatError(`${where}'s maze-confirmation flag is invalid.`);
  }
  for (const [name, value] of [['day', video.meta.day], ['trial', video.meta.trial]] as const) {
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      throw new ProjectFormatError(`${where}'s ${name} must be a non-negative integer or blank.`);
    }
  }
  if (!Array.isArray(video.corrections) || !Array.isArray(video.notes) || video.notes.some((note) => typeof note !== 'string')) {
    throw new ProjectFormatError(`${where} has malformed notes or corrections.`);
  }
  if (video.strategyOverride !== null) {
    const strategies: ReadonlyArray<SearchStrategy> = ['spatial', 'serial', 'random', 'unclassified'];
    if (!strategies.includes(video.strategyOverride.strategy as SearchStrategy) || typeof video.strategyOverride.reason !== 'string') {
      throw new ProjectFormatError(`${where} has an invalid human strategy override.`);
    }
  }
}

function validateTrialStart(start: TrialStart | undefined, count: number, where: string): void {
  const reasons: ReadonlyArray<TrialStart['reason']> = ['cylinderLift', 'animalAppeared', 'fileStart', 'manual'];
  if (!start || !Number.isInteger(start.frame) || start.frame < 0 || start.frame >= count ||
      !reasons.includes(start.reason) || typeof start.evidence !== 'string') {
    throw new ProjectFormatError(`${where} is invalid.`);
  }
  validProvenance(start.provenance, `${where}'s provenance`);
}

function validateCorrections(corrections: ReadonlyArray<ManualCorrection>, video: StoredVideo, where: string): void {
  const frames = new Set<number>();
  const statuses: ReadonlyArray<FrameStatus> = ['preTrial', 'tracked', 'partial', 'inHole', 'lost', 'postTrial'];
  for (const correction of corrections) {
    if (!correction || !Number.isInteger(correction.frame) || correction.frame < 0 || correction.frame >= video.observations.count) {
      throw new ProjectFormatError(`${where} has a frame correction outside the recording.`);
    }
    if (frames.has(correction.frame)) throw new ProjectFormatError(`${where} has two corrections for frame ${correction.frame}.`);
    frames.add(correction.frame);
    if (correction.status !== undefined && !statuses.includes(correction.status)) {
      throw new ProjectFormatError(`${where} has an invalid status correction at frame ${correction.frame}.`);
    }
    if (correction.body !== undefined && correction.body !== null) finitePoint(correction.body, `${where}'s body correction`);
    if (correction.nose !== undefined && correction.nose !== null) finitePoint(correction.nose, `${where}'s nose correction`);
    if (correction.holeIndex !== undefined && correction.holeIndex !== null &&
        (!Number.isInteger(correction.holeIndex) || correction.holeIndex < 0 || correction.holeIndex >= video.geometry.holeCount)) {
      throw new ProjectFormatError(`${where} has an out-of-range hole correction at frame ${correction.frame}.`);
    }
    if (correction.holeIndex !== undefined && correction.holeIndex !== null && correction.status !== 'inHole') {
      throw new ProjectFormatError(`${where} assigns a hole without an inside-hole label at frame ${correction.frame}.`);
    }
    if (correction.status === 'inHole' && (correction.holeIndex === undefined || correction.holeIndex === null)) {
      throw new ProjectFormatError(`${where} has an inside-hole label without a hole at frame ${correction.frame}.`);
    }
    if (correction.note !== undefined && typeof correction.note !== 'string') {
      throw new ProjectFormatError(`${where} has a malformed correction note at frame ${correction.frame}.`);
    }
  }
}

function validProvenance(value: Provenance, where: string): void {
  if (value !== 'auto' && value !== 'template' && value !== 'manual') {
    throw new ProjectFormatError(`${where} is invalid.`);
  }
}

function finitePoint(value: Point | undefined, where: string): void {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw new ProjectFormatError(`${where} is not a finite coordinate.`);
  }
}

function finitePositive(value: unknown, where: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ProjectFormatError(`${where} must be a positive finite number.`);
  }
}

function finiteNumber(value: unknown, where: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProjectFormatError(`${where} must be a finite number.`);
  }
}

function finiteNonNegative(value: unknown, where: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ProjectFormatError(`${where} must be a non-negative finite number.`);
  }
}

function finiteFraction(value: unknown, where: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ProjectFormatError(`${where} must be between 0 and 1.`);
  }
}

function validTimestamp(value: string, where: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new ProjectFormatError(`${where} is invalid.`);
}

/**
 * A filename that sorts, is unique enough, and says what it is.
 */
export function suggestProjectFileName(projectName: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = projectName.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'barnes-maze';
  return `${safe}-${stamp}.bmproj.json`;
}
