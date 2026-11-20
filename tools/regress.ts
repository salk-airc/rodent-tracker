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
import { SAMPLE_CLIPS } from '../src/paradigms/barnes/samples';
import type { MazeGeometry } from '../src/paradigms/barnes/types';

const DATA_DIR = 'data/barnes-maze';
const OUT_DIR = 'outputs/barnes';
const check = process.argv.includes('--check');
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
  const body = JSON.stringify(result, null, 2);
  const frames = out.track.frames.map((f) => `    ${JSON.stringify(f)}`).join(',\n');
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

function compareOrWrite(path: string, text: string): void {
  if (!check) {
    writeFileSync(path, text, 'utf8');
    return;
  }
  if (!existsSync(path)) failures.push(`${path} is missing`);
  else if (readFileSync(path, 'utf8') !== text) failures.push(`${path} differs`);
}
