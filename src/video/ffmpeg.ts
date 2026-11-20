/**
 * A FrameSource backed by ffmpeg, for use outside the browser.
 *
 * This exists so the numbers committed to the repo, the numbers CI checks, and
 * the numbers the app shows all come from the same analysis code. Only the way
 * pixels arrive differs: WebCodecs in the browser, an ffmpeg pipe here.
 *
 * Not part of the shipped app, and the scientist never needs ffmpeg.
 */

import { spawn, spawnSync } from 'node:child_process';
import type { FrameSource, Timebase, TimingReport } from '../types';
import { describeTiming } from '../time';

export interface ProbeResult {
  readonly width: number;
  readonly height: number;
  readonly timebase: Timebase;
  readonly timing: TimingReport;
}

function runProbe(args: string[]): string {
  const r = spawnSync('ffprobe', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`ffprobe could not be run: ${r.error.message}. Install ffmpeg.`);
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`);
  return r.stdout;
}

/**
 * Read dimensions and the full presentation-timestamp table.
 *
 * ffprobe lists frames in *decode* order, and these files use B-frames, so the
 * timestamps come out non-monotonic. Sorting them recovers presentation order,
 * which is the order every decoder hands frames to us and the order the
 * analysis assumes.
 */
export function probeVideo(path: string): ProbeResult {
  const dims = runProbe([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,time_base',
    '-of', 'default=noprint_wrappers=1:nokey=0',
    path,
  ]);
  const width = Number(/width=(\d+)/.exec(dims)?.[1]);
  const height = Number(/height=(\d+)/.exec(dims)?.[1]);
  const tbMatch = /time_base=(\d+)\/(\d+)/.exec(dims);
  if (!width || !height || !tbMatch) throw new Error(`Could not read video properties from ${path}`);
  const timescale = Number(tbMatch[2]);

  const raw = runProbe([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'frame=pts',
    '-of', 'csv=p=0:nk=1',
    path,
  ]);
  const sorted = raw
    .split('\n')
    .map((l) => l.trim().replace(/,+$/, ''))
    .filter((l) => /^\d+$/.test(l))
    .map(Number)
    .sort((a, b) => a - b);

  if (sorted.length === 0) throw new Error(`No video frames found in ${path}`);
  // Zero-based, matching the browser decoder, so a time reported here and a
  // time reported in the app mean the same thing.
  const first = sorted[0]!;
  const ptsTicks = sorted.map((p) => p - first);

  return { width, height, timebase: { timescale, ptsTicks }, timing: describeTiming(timescale, ptsTicks) };
}

export class FfmpegFrameSource implements FrameSource {
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly timebase: Timebase;
  readonly timing: TimingReport;
  private readonly path: string;

  constructor(path: string) {
    const probe = probeVideo(path);
    this.path = path;
    this.width = probe.width;
    this.height = probe.height;
    this.timebase = probe.timebase;
    this.timing = probe.timing;
    this.frameCount = probe.timebase.ptsTicks.length;
  }

  async scan(
    range: { readonly from: number; readonly to: number },
    visit: (frame: number, gray: Uint8Array) => void | Promise<void>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    const from = Math.max(0, range.from);
    const to = Math.min(this.frameCount - 1, range.to);
    if (to < from) return;
    const bytes = this.width * this.height;
    const total = to - from + 1;

    // Decoding from the start and discarding is faster than seeking, and it
    // sidesteps the question of whether -ss lands on the frame we asked for.
    const proc = spawn(
      'ffmpeg',
      ['-v', 'error', '-i', this.path, '-vf', 'format=gray', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    const buf = new Uint8Array(bytes);
    let filled = 0;
    let frame = 0;
    let done = 0;
    let failure: unknown = null;

    const pending: Buffer[] = [];
    let resolveChunk: (() => void) | null = null;
    let ended = false;

    proc.stdout.on('data', (chunk: Buffer) => {
      pending.push(chunk);
      resolveChunk?.();
      resolveChunk = null;
    });
    proc.stdout.on('end', () => {
      ended = true;
      resolveChunk?.();
      resolveChunk = null;
    });
    proc.on('error', (e) => {
      failure = e;
      ended = true;
      resolveChunk?.();
      resolveChunk = null;
    });

    while (!ended || pending.length > 0) {
      if (pending.length === 0) {
        await new Promise<void>((res) => {
          resolveChunk = res;
        });
        continue;
      }
      const chunk = pending.shift()!;
      let offset = 0;
      while (offset < chunk.length) {
        const take = Math.min(bytes - filled, chunk.length - offset);
        buf.set(chunk.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === bytes) {
          if (frame >= from && frame <= to) {
            await visit(frame, buf);
            done++;
            if (done % 100 === 0) onProgress?.(done, total);
          }
          filled = 0;
          frame++;
          if (frame > to) {
            proc.kill('SIGTERM');
          }
        }
      }
    }

    if (failure) throw failure;
    if (frame === 0) throw new Error(`ffmpeg produced no frames for ${this.path}: ${stderr}`);
    onProgress?.(total, total);
  }

  /** Random access, by scanning. Fine for a handful of frames; do not loop over it. */
  async getGrayFrame(frame: number): Promise<Uint8Array> {
    let out: Uint8Array | null = null;
    await this.scan({ from: frame, to: frame }, (_f, gray) => {
      out = Uint8Array.from(gray);
    });
    if (!out) throw new RangeError(`frame ${frame} could not be decoded`);
    return out;
  }

  close(): void {
    /* nothing retained */
  }
}
