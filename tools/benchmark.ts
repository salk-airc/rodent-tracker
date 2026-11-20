/**
 * Compare detectors on the sample clips against the reviewed labels.
 *
 *   pnpm benchmark            print the table
 *   pnpm benchmark --write    also write docs/BENCHMARK.md
 *
 * Every detector runs through the same pipeline (same background, arena,
 * resolve, events), so differences come from detection alone. The labels are
 * coarse and partly agent-made (see the fixture's caveat): treat this as a
 * regression and comparison set, not as validation.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FfmpegFrameSource } from '../src/video/ffmpeg';
import { analyzeVideo, reanalyze, type AnalysisOutcome } from '../src/paradigms/barnes/pipeline';
import { DEFAULT_PARAMS } from '../src/paradigms/barnes/params';
import { ensureSampleClips, SAMPLE_CLIPS, SAMPLE_DIR } from '../src/paradigms/barnes/samples';
import type { MazeGeometry, Point } from '../src/paradigms/barnes/types';
import type { DetectorFactory } from '../src/detect/types';
import { darkBlobDetector } from '../src/detect/darkBlob';
import { silhouetteTaperDetector } from '../src/detect/silhouetteTaper';

interface NoseLabel {
  video: string;
  frame: number;
  category: string;
  visible: boolean;
  nose: Point | null;
  tolerancePx: number | null;
}
interface InvestigationWindow {
  video: string;
  startFrame: number;
  endFrame: number;
  investigations: { hole: number; startFrame: number; endFrame: number }[];
}
const labels = JSON.parse(readFileSync('tests/fixtures/reviewed-labels.json', 'utf8')) as {
  nose: NoseLabel[];
  investigationWindows: InvestigationWindow[];
};

const DETECTORS: Array<[string, DetectorFactory]> = [
  ['dark-blob-v1', darkBlobDetector],
  ['silhouette-taper-v1', silhouetteTaperDetector],
];

/** The labels number 20 holes from the top, clockwise in the video. */
function holeIndexAt(geometry: MazeGeometry, labelHole: number): number {
  const angle = -Math.PI / 2 + ((labelHole - 1) * 2 * Math.PI) / 20;
  const offset = (hole: MazeGeometry['holes'][number]) => {
    const a = Math.atan2(hole.center.y - geometry.center.y, hole.center.x - geometry.center.x) - angle;
    return Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
  };
  return geometry.holes.reduce((best, hole) => (offset(hole) < offset(best) ? hole : best)).index;
}

interface Run {
  outcome: AnalysisOutcome;
  ms: number;
}

await ensureSampleClips(SAMPLE_DIR, (line) => console.error(line));
const runs = new Map<string, Map<string, Run>>();
for (const [id, factory] of DETECTORS) {
  const byClip = new Map<string, Run>();
  for (const clip of SAMPLE_CLIPS) {
    const path = join(SAMPLE_DIR, `${clip}.mp4`);
    process.stderr.write(`${id} ${clip}… `);
    const started = performance.now();
    const src = new FfmpegFrameSource(path);
    const obs = await analyzeVideo(clip, src, { params: DEFAULT_PARAMS, detector: factory });
    const first = reanalyze(obs, { params: DEFAULT_PARAMS, timebase: src.timebase });
    const suggestion = first.targetSuggestion;
    const outcome = suggestion
      ? reanalyze(obs, {
          params: DEFAULT_PARAMS,
          timebase: src.timebase,
          geometry: { ...obs.geometry, targetHoleIndex: suggestion.holeIndex, targetProvenance: 'auto' },
        })
      : first;
    src.close();
    const ms = performance.now() - started;
    process.stderr.write(`${Math.round(ms)} ms\n`);
    byClip.set(`${clip}.mp4`, { outcome, ms });
  }
  runs.set(id, byClip);
}

interface Score {
  noseVisibleHit: number;
  noseVisibleTotal: number;
  noseHiddenHit: number;
  noseHiddenTotal: number;
  noseErrors: number[];
  noseMisses: string[];
  investigationsFound: number;
  investigationsTotal: number;
  investigationMisses: string[];
  extraInWindows: number;
  trackedFraction: number;
  /** Brief reversals: the nose swings to the other end of the body and back within 0.3 s. */
  noseFlips: number;
  noseFrames: number;
  ms: number;
}

const scores = new Map<string, Score>();
for (const [id, byClip] of runs) {
  const s: Score = {
    noseVisibleHit: 0, noseVisibleTotal: 0, noseHiddenHit: 0, noseHiddenTotal: 0, noseErrors: [], noseMisses: [],
    investigationsFound: 0, investigationsTotal: 0, investigationMisses: [], extraInWindows: 0, trackedFraction: 0, noseFlips: 0, noseFrames: 0, ms: 0,
  };
  for (const label of labels.nose) {
    const { outcome } = byClip.get(label.video)!;
    const frame = outcome.track.frames.find((f) => f.frame === label.frame);
    const nose = frame && frame.status !== 'inHole' && !frame.interpolated ? frame.nose : null;
    const where = `${label.video} ${label.frame} (${label.category})`;
    if (!label.visible) {
      s.noseHiddenTotal++;
      if (nose === null) s.noseHiddenHit++;
      else s.noseMisses.push(`${where}: reported a nose that is hidden`);
      continue;
    }
    s.noseVisibleTotal++;
    if (nose === null) {
      s.noseMisses.push(`${where}: no nose`);
      continue;
    }
    const err = Math.hypot(nose.x - label.nose!.x, nose.y - label.nose!.y);
    s.noseErrors.push(err);
    if (err <= label.tolerancePx!) s.noseVisibleHit++;
    else s.noseMisses.push(`${where}: ${err.toFixed(0)} px off`);
  }
  for (const window of labels.investigationWindows) {
    const { outcome } = byClip.get(window.video)!;
    const geometry = outcome.observations.geometry;
    const inWindow = outcome.events.filter(
      (e) => e.type === 'investigation' && e.startFrame <= window.endFrame && e.endFrame >= window.startFrame,
    );
    const matched = new Set<string>();
    for (const reviewed of window.investigations) {
      s.investigationsTotal++;
      const hole = holeIndexAt(geometry, reviewed.hole);
      const hit = inWindow.find(
        (e) => e.holeIndex === hole && e.startFrame <= reviewed.endFrame + 3 && e.endFrame >= reviewed.startFrame - 3,
      );
      if (hit) {
        s.investigationsFound++;
        matched.add(hit.id);
      } else {
        s.investigationMisses.push(`${window.video} hole ${reviewed.hole} frames ${reviewed.startFrame}-${reviewed.endFrame}`);
      }
    }
    s.extraInWindows += inWindow.filter((e) => !matched.has(e.id)).length;
  }
  let tracked = 0;
  let total = 0;
  for (const { outcome, ms } of byClip.values()) {
    for (const f of outcome.track.frames) {
      if (f.status === 'preTrial' || f.status === 'postTrial') continue;
      total++;
      if (f.status === 'tracked' && !f.interpolated) tracked++;
    }
    s.ms += ms;
    const flips = countNoseFlips(outcome);
    s.noseFlips += flips.flips;
    s.noseFrames += flips.frames;
  }
  s.trackedFraction = total ? tracked / total : 0;
  scores.set(id, s);
}

/**
 * Label-free check on nose orientation. A real turn takes the nose around
 * the body; a detector error jumps it straight to the tail end and back.
 * Counts runs of up to 9 frames (0.3 s at 30 fps) whose nose direction is
 * reversed (cosine below -0.5) relative to agreeing frames on both sides.
 */
function countNoseFlips(outcome: AnalysisOutcome): { flips: number; frames: number } {
  const dirs = outcome.track.frames.map((f) => {
    if (f.status !== 'tracked' || f.interpolated || !f.body || !f.nose) return null;
    const dx = f.nose.x - f.body.x;
    const dy = f.nose.y - f.body.y;
    const len = Math.hypot(dx, dy);
    return len > 0 ? { x: dx / len, y: dy / len } : null;
  });
  const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
  let flips = 0;
  let frames = 0;
  for (let i = 1; i < dirs.length; i++) {
    const prev = dirs[i - 1];
    const cur = dirs[i];
    if (cur) frames++;
    if (!prev || !cur || dot(prev, cur) >= -0.5) continue;
    for (let j = i + 1; j < Math.min(dirs.length, i + 10); j++) {
      const next = dirs[j];
      if (next && dot(next, prev) > 0.5) {
        flips++;
        i = j;
        break;
      }
    }
  }
  return { flips, frames };
}

/** Median distance between two detectors' body points, over frames both tracked. */
function agreement(a: string, b: string): string {
  const parts: string[] = [];
  for (const clip of SAMPLE_CLIPS) {
    const fa = runs.get(a)!.get(`${clip}.mp4`)!.outcome.track.frames;
    const fb = runs.get(b)!.get(`${clip}.mp4`)!.outcome.track.frames;
    const d: number[] = [];
    for (let i = 0; i < Math.min(fa.length, fb.length); i++) {
      const pa = fa[i]!.status === 'tracked' ? fa[i]!.body : null;
      const pb = fb[i]!.status === 'tracked' ? fb[i]!.body : null;
      if (pa && pb) d.push(Math.hypot(pa.x - pb.x, pa.y - pb.y));
    }
    d.sort((x, y) => x - y);
    const q = (f: number) => d[Math.floor(f * (d.length - 1))] ?? Number.NaN;
    parts.push(`${clip}: median ${q(0.5).toFixed(1)} px, 95th ${q(0.95).toFixed(1)} px (${d.length} frames)`);
  }
  return parts.join('; ');
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : Number.NaN;
};

const ids = DETECTORS.map(([id]) => id);
const row = (name: string, f: (s: Score) => string) => `| ${name} | ${ids.map((id) => f(scores.get(id)!)).join(' | ')} |`;
const lines = [
  '# Detector benchmark',
  '',
  `Generated by \`pnpm benchmark --write\` on the three sample clips (\`pnpm samples\`), scored against`,
  '`tests/fixtures/reviewed-labels.json`. Those labels are coarse, partly made by an agent and not',
  'blind, so this compares detectors; it does not validate either one.',
  '',
  `| | ${ids.join(' | ')} |`,
  `|---|${ids.map(() => '---').join('|')}|`,
  row('Visible nose within tolerance', (s) => `${s.noseVisibleHit} / ${s.noseVisibleTotal}`),
  row('Median nose error (visible)', (s) => `${median(s.noseErrors).toFixed(1)} px`),
  row('Hidden nose left blank', (s) => `${s.noseHiddenHit} / ${s.noseHiddenTotal}`),
  row('Reviewed investigations found', (s) => `${s.investigationsFound} / ${s.investigationsTotal}`),
  row('Unmatched investigations in reviewed windows', (s) => String(s.extraInWindows)),
  row('Trial frames tracked (not interpolated)', (s) => `${(s.trackedFraction * 100).toFixed(1)}%`),
  row('Brief nose flips (no labels needed)', (s) => `${s.noseFlips} in ${s.noseFrames} frames`),
  row('Time for all 3 clips', (s) => `${(s.ms / 1000).toFixed(1)} s`),
  '',
  `Body agreement between ${ids[0]} and ${ids[1]}: ${agreement(ids[0]!, ids[1]!)}.`,
  '',
  '## Misses',
  '',
  ...ids.flatMap((id) => {
    const s = scores.get(id)!;
    const misses = [...s.noseMisses.map((m) => `nose: ${m}`), ...s.investigationMisses.map((m) => `investigation: ${m}`)];
    return [`**${id}**`, '', ...(misses.length ? misses.map((m) => `- ${m}`) : ['- none']), ''];
  }),
];
const text = lines.join('\n');
console.log(text);
if (process.argv.includes('--write')) {
  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/BENCHMARK.md', text);
}
