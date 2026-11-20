/**
 * Dev-side harness: run the analysis on the sample clips and write the outputs
 * that are committed to the repo.
 *
 * The scientist never runs this and never needs ffmpeg. It exists so that the
 * numbers in the repository, the numbers CI checks, and the numbers the browser
 * shows all come out of the same code — only the source of pixels differs.
 *
 *   pnpm analyze            regenerate outputs/
 *   pnpm analyze --check    fail if the committed outputs have drifted
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { SAMPLE_CLIPS } from '../src/paradigms/barnes/samples';
import { join } from 'node:path';
import { FfmpegFrameSource } from '../src/video/ffmpeg';
import { analyzeVideo, reanalyze } from '../src/paradigms/barnes/pipeline';
import { DEFAULT_PARAMS } from '../src/paradigms/barnes/params';
import { parseFilename } from '../src/paradigms/barnes/project/filename';
import { packObservations, TOOL_VERSION } from '../src/paradigms/barnes/project/schema';
import { writeProject } from '../src/paradigms/barnes/project/io';
import { scientificReadinessReasons } from '../src/paradigms/barnes/project/readiness';
import { videoMeasurementBasis } from '../src/paradigms/barnes/measurementBasis';
import {
  eventDetailTable,
  frameDetailTable,
  parametersTable,
  recordingSettings,
  qualityTable,
  trialSummaryTable,
  type ExportInput,
} from '../src/paradigms/barnes/io/tables';
import { toCsv } from '../src/io/csv';
import { toXlsx } from '../src/io/xlsx';
import { trialOverviewTable } from '../src/paradigms/barnes/io/review';
import { reviewReportHtml } from '../src/paradigms/barnes/io/report';
import { frameTime } from '../src/time';
import { holeNumber, type MazeGeometry } from '../src/paradigms/barnes/types';

const DATA_DIR = 'data/barnes-maze';
const OUT_DIR = 'outputs';
const check = process.argv.includes('--check');
const existingSample = readExistingSampleProject();
// A regeneration records when it actually happened. Check mode reuses those
// recorded times so byte comparison stays deterministic without inventing a
// date and labeling it as an analysis time.
const OUTPUT_TIMESTAMP = check && existingSample?.updatedAt
  ? existingSample.updatedAt
  : new Date().toISOString();

const inputs: ExportInput[] = [];
const storedVideos: Parameters<typeof writeProject>[0]['videos'][number][] = [];
let written = 0;
const failures: string[] = [];

mkdirSync(OUT_DIR, { recursive: true });

for (const clip of SAMPLE_CLIPS) {
  const path = join(DATA_DIR, `${clip}.mp4`);
  if (!existsSync(path)) {
    console.error(`missing ${path}; see data/barnes-maze/README.md`);
    process.exit(1);
  }
  process.stderr.write(`analyzing ${clip}... `);
  const started = Date.now();
  const src = new FfmpegFrameSource(path);
  const obs = await analyzeVideo(clip, src, { params: DEFAULT_PARAMS });

  // The regression harness deliberately carries the automatic suggestion into
  // its committed outputs. The browser treats the same result as provisional
  // and blocks scientific export until a person confirms it.
  const first = reanalyze(obs, { params: DEFAULT_PARAMS, timebase: src.timebase });
  const suggestion = first.targetSuggestion;
  const geometry: MazeGeometry = suggestion
    ? { ...obs.geometry, targetHoleIndex: suggestion.holeIndex, targetProvenance: 'auto' }
    : obs.geometry;
  const out = reanalyze(obs, { params: DEFAULT_PARAMS, timebase: src.timebase, geometry });
  const measurementBasis = videoMeasurementBasis(DEFAULT_PARAMS, obs.geometry);

  const analyzedAt = check
    ? existingSample?.videos.find((video) => video.id === clip)?.analyzedAt ?? null
    : new Date().toISOString();
  const provisionalReasons = scientificReadinessReasons({
    mazeConfirmed: false,
    geometry: out.observations.geometry,
    trackingSource: 'video',
    measurementBasis,
    detectedTrialStart: out.observations.detectedTrialStart,
    trialStartOverride: null,
  }, DEFAULT_PARAMS, out.measures);
  if (provisionalReasons.length === 0) {
    throw new Error(`${clip} unexpectedly passed the human-confirmation gate; sample artifacts must remain provisional.`);
  }
  const input: ExportInput = {
    videoId: clip,
    fileName: `${clip}.mp4`,
    trackingSource: 'video',
    measurementBasis,
    observationToolVersion: TOOL_VERSION,
    resultStatus: 'provisional',
    provisionalReasons,
    meta: parseFilename(`${clip}.mp4`),
    geometry: out.observations.geometry,
    measures: out.measures,
    events: out.events,
    frames: out.track.frames,
    gaps: out.gaps,
    warnings: out.warnings,
    params: DEFAULT_PARAMS,
    timebase: src.timebase,
    trialStartFrame: out.track.trialStart.frame,
    trialStartReason: out.track.trialStart.reason,
    strategyOverride: null,
    analyzedAt,
  };
  inputs.push(input);

  storedVideos.push({
    id: clip,
    fileName: `${clip}.mp4`,
    fileSize: null,
    analyzedAt,
    observationToolVersion: TOOL_VERSION,
    meta: input.meta,
    width: obs.width,
    height: obs.height,
    timebase: { timescale: src.timebase.timescale, ptsTicks: src.timebase.ptsTicks },
    geometry: out.observations.geometry,
    trackingSource: 'video',
    measurementBasis,
    mazeConfirmed: false,
    rigId: null,
    bodyAreaPx: obs.bodyAreaPx,
    bodyAreaSpread: obs.bodyAreaSpread,
    detectedTrialStart: out.observations.detectedTrialStart,
    trialStartOverride: null,
    observations: packObservations(obs.observations),
    corrections: [],
    strategyOverride: null,
    notes: obs.notes,
  });

  // Per-video frame detail: too large to merge into one file usefully.
  writeArtifact(join(OUT_DIR, `${clip}-frames.csv`), toCsv(frameDetailTable(input)));

  process.stderr.write(`${Date.now() - started} ms\n`);
  src.close();
}

const summary = trialSummaryTable(inputs);
const overview = trialOverviewTable(inputs);
const events = eventDetailTable(inputs);
const quality = qualityTable(inputs);
const parameters = parametersTable(DEFAULT_PARAMS, inputs.map(recordingSettings));

writeArtifact(join(OUT_DIR, 'trial-summary.csv'), toCsv(summary));
writeArtifact(join(OUT_DIR, 'trial-overview.csv'), toCsv(overview));
writeArtifact(join(OUT_DIR, 'review-report.html'), reviewReportHtml('Sample clips', inputs));
writeArtifact(join(OUT_DIR, 'events.csv'), toCsv(events));
writeArtifact(join(OUT_DIR, 'quality-report.csv'), toCsv(quality));
writeArtifact(join(OUT_DIR, 'parameters.csv'), toCsv(parameters));
writeArtifact(
  join(OUT_DIR, 'barnes-maze-results.xlsx'),
  toXlsx([overview, summary, events, quality, parameters], {
    creator: 'Barnes Maze Analyzer',
    createdAt: new Date(OUTPUT_TIMESTAMP),
  }),
);
writeArtifact(
  join(OUT_DIR, 'sample-project.bmproj.json'),
  writeProject({
    createdAt: OUTPUT_TIMESTAMP,
    project: { name: 'Sample clips' },
    params: DEFAULT_PARAMS,
    rigs: [],
    videos: storedVideos,
    excludedVideos: [],
  }, { updatedAt: OUTPUT_TIMESTAMP }),
);

writeArtifact(join(OUT_DIR, 'README.md'), outputsReadme(inputs));

if (check && failures.length) {
  console.error(`\n${failures.length} committed output(s) differ from a fresh run:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error('\nRun `pnpm analyze` and commit the result if the change is intended.');
  process.exit(1);
}
console.error(check ? '\ncommitted outputs match a fresh run' : `\nwrote ${written} file(s) to ${OUT_DIR}/`);

// ---------------------------------------------------------------------------

function writeArtifact(path: string, content: string | Uint8Array): void {
  if (!check) {
    if (typeof content === 'string') writeFileSync(path, content, 'utf8');
    else writeFileSync(path, Buffer.from(content));
    written++;
    return;
  }
  if (!existsSync(path)) {
    failures.push(`${path} is missing`);
    return;
  }
  if (typeof content === 'string') {
    if (readFileSync(path, 'utf8') !== content) failures.push(`${path} differs`);
  } else {
    const existing = readFileSync(path);
    if (existing.length !== content.length || existing.some((byte, index) => byte !== content[index])) {
      failures.push(`${path} differs`);
    }
  }
}

function readExistingSampleProject(): {
  readonly updatedAt?: string;
  readonly videos: ReadonlyArray<{ readonly id: string; readonly analyzedAt: string | null }>;
} | null {
  const path = join(OUT_DIR, 'sample-project.bmproj.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      updatedAt?: unknown;
      videos?: unknown;
    };
    const videos = Array.isArray(parsed.videos)
      ? parsed.videos
          .filter((video): video is Record<string, unknown> & { id: string } =>
            typeof video === 'object' && video !== null && typeof (video as { id?: unknown }).id === 'string',
          )
          .map((video) => ({
            id: video.id,
            analyzedAt: typeof video.analyzedAt === 'string' ? video.analyzedAt : null,
          }))
      : [];
    return {
      ...(typeof parsed.updatedAt === 'string' ? { updatedAt: parsed.updatedAt } : {}),
      videos,
    };
  } catch {
    return null;
  }
}

function outputsReadme(all: ReadonlyArray<ExportInput>): string {
  const lines: string[] = [];
  lines.push('# Generated outputs');
  lines.push('');
  lines.push('Produced by `pnpm analyze` from the three clips in [`data/barnes-maze/`](../data/barnes-maze/).');
  lines.push('');
  lines.push('> [!WARNING]');
  lines.push('> Provisional regression artifacts only. Maze outlines, scale, and suggested escape holes are unconfirmed.');
  lines.push('> Tables mark every row `provisional` and list the missing confirmations. Do not use them as scientific results.');
  lines.push('');
  lines.push('| File | What it is |');
  lines.push('|---|---|');
  lines.push('| `review-report.html` | Printable review of all three clips, with qualifications, events, and settings. |');
  lines.push('| `trial-overview.csv` | Concise per-trial measurements and review notes. |');
  lines.push('| `trial-summary.csv` | Full per-trial measurements and provenance. |');
  lines.push('| `events.csv` | Hole investigations and entries with evidence. |');
  lines.push('| `quality-report.csv` | Tracking gaps and warnings. |');
  lines.push('| `parameters.csv` | The settings these numbers came from. |');
  lines.push('| `barnes-maze-results.xlsx` | Overview, trial details, events, quality, and parameters in one workbook. |');
  lines.push('| `*-frames.csv` | Per-frame positions, one file per clip. |');
  lines.push('| `sample-project.bmproj.json` | Reloadable project with saved tracking. |');
  lines.push('');
  lines.push('## Provisional pipeline output');
  lines.push('');
  lines.push('| Clip | Status | Trial start | Suggested target | Primary latency | Total latency | Errors | Measured path | Strategy | Coverage |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const i of all) {
    const m = i.measures;
    const lat = (l: typeof m.primaryLatency) =>
      l.observed ? `${l.sec.toFixed(2)} s` : `≥ ${l.sec.toFixed(2)} s *(censored)*`;
    const errors = (count: number, coverage: number) =>
      coverage <= 0 ? 'n/a' : coverage < 1 ? `≥ ${count}` : String(count);
    const pathLength = Number.isFinite(m.pathLengthCm)
      ? `${m.pathLengthCoverage < 1 ? '≥ ' : ''}${m.pathLengthCm.toFixed(0)} cm`
      : 'n/a';
    lines.push(
      `| \`${i.fileName}\` | **provisional** | ${frameTime(i.timebase, i.trialStartFrame).toFixed(2)} s (${i.trialStartReason}) ` +
        `| ${i.geometry.targetHoleIndex === null ? '—' : holeNumber(i.geometry, i.geometry.targetHoleIndex)} | ${lat(m.primaryLatency)} | ${lat(m.totalLatency)} ` +
        `| ${errors(m.primaryErrors, m.primaryErrorCoverage)} / ${errors(m.totalErrors, m.totalErrorCoverage)} | ${pathLength} | ${m.strategy.strategy} ` +
        `| ${(m.quality.measuredPositionFraction * 100).toFixed(1)}% |`,
    );
  }
  lines.push('');
  lines.push('All rows are provisional. Errors are primary / total; ≥ marks incomplete tracking and n/a marks no usable evidence. Censored latency is a cutoff lower bound, not a measurement.');
  lines.push('Hole numbers are the one-based labels shown clockwise in the application.');
  lines.push('');
  lines.push('## What the tool was unsure about');
  lines.push('');
  for (const i of all) {
    const warnings = [...i.measures.warnings, ...i.measures.quality.warnings];
    lines.push(`**\`${i.fileName}\`**`);
    lines.push('');
    if (warnings.length === 0) lines.push('- No detector warnings.');
    for (const w of warnings) lines.push(`- ${w}`);
    lines.push('');
  }
  return `${lines.join('\n')}`;
}
