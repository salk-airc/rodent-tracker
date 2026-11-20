/**
 * Regression on the scoring itself: run the Barnes maze analysis on the three
 * sample clips and compare everything it concludes (maze geometry, trial
 * start, track, events, measures, warnings) with the committed results.
 *
 *   pnpm analyze            rewrite outputs/barnes/
 *   pnpm regress            fail if a fresh run differs from outputs/barnes/
 *
 * Exports built from these results (CSV, XLSX, project files, the review
 * report) are checked in tracking-platform, which owns them.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FfmpegFrameSource } from '../src/video/ffmpeg';
import { analyzeVideo, reanalyze } from '../src/paradigms/barnes/pipeline';
import { DEFAULT_PARAMS } from '../src/paradigms/barnes/params';
import { SAMPLE_CLIPS, SAMPLE_DIR } from '../src/paradigms/barnes/samples';
import { ensureSampleClips } from '../src/paradigms/barnes/sampleFiles';
import type { MazeGeometry } from '../src/paradigms/barnes/types';

const DATA_DIR = SAMPLE_DIR;
const OUT_DIR = 'outputs/barnes';
const check = process.argv.includes('--check');
const failures: string[] = [];
mkdirSync(OUT_DIR, { recursive: true });
await ensureSampleClips(DATA_DIR, (line) => console.error(line));

for (const clip of SAMPLE_CLIPS) {
  const path = join(DATA_DIR, `${clip}.mp4`);
  process.stderr.write(`analyzing ${clip}... `);
  const started = Date.now();
  const src = new FfmpegFrameSource(path);
  const obs = await analyzeVideo(clip, src, { params: DEFAULT_PARAMS });
  // Score against the automatically suggested target, as an unreviewed run would.
  const first = reanalyze(obs, { params: DEFAULT_PARAMS, timebase: src.timebase });
  const geometry: MazeGeometry = first.targetSuggestion
    ? { ...obs.geometry, targetHoleIndex: first.targetSuggestion.holeIndex, targetProvenance: 'auto' }
    : obs.geometry;
  const out = reanalyze(obs, { params: DEFAULT_PARAMS, timebase: src.timebase, geometry });
  src.close();

  const result = {
    clip,
    width: obs.width,
    height: obs.height,
    bodyAreaPx: obs.bodyAreaPx,
    bodyAreaSpread: obs.bodyAreaSpread,
    notes: obs.notes,
    geometry: out.observations.geometry,
    targetSuggestion: first.targetSuggestion,
    trialStart: out.track.trialStart,
    quality: out.track.quality,
    gaps: out.gaps,
    events: out.events,
    measures: out.measures,
    warnings: out.warnings,
  };
  // One frame per line, so a diff points at the frames that changed.
  const body = JSON.stringify(result, roundFloats, 2);
  const frames = out.track.frames.map((f) => `    ${JSON.stringify(f, roundFloats)}`).join(',\n');
  const text = `${body.slice(0, -2)},\n  "frames": [\n${frames}\n  ]\n}\n`;
  compareOrWrite(join(OUT_DIR, `${clip}.json`), text);
  process.stderr.write(`${Date.now() - started} ms\n`);
}

if (check && failures.length) {
  console.error(`\n${failures.length} committed result(s) differ from a fresh run:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error('\nRun `pnpm analyze` and commit the result if the change is intended.');
  process.exit(1);
}
console.error(check ? '\ncommitted results match a fresh run' : `\nwrote ${SAMPLE_CLIPS.length} file(s) to ${OUT_DIR}/`);

/**
 * Math library results can differ in the last bit between platforms (a frame's
 * confidence came out …4656 on macOS and …4657 on Linux), so store 12
 * significant digits: far finer than anything scored, coarse enough to agree.
 */
function roundFloats(_key: string, value: unknown): unknown {
  return typeof value === 'number' && !Number.isInteger(value) ? Number(value.toPrecision(12)) : value;
}

function compareOrWrite(path: string, text: string): void {
  if (!check) {
    writeFileSync(path, text, 'utf8');
    return;
  }
  if (!existsSync(path)) {
    failures.push(`${path} is missing`);
    return;
  }
  const committed = readFileSync(path, 'utf8');
  if (committed === text) return;
  failures.push(`${path} differs`);
  // Show the first few lines that changed, so a CI log says what moved.
  const a = committed.split('\n');
  const b = text.split('\n');
  let shown = 0;
  let changed = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    changed++;
    if (shown++ < 8) console.error(`${path}:${i + 1}\n  - ${a[i]?.slice(0, 200)}\n  + ${b[i]?.slice(0, 200)}`);
  }
  console.error(`${path}: ${changed} of ${a.length} lines differ`);
}
