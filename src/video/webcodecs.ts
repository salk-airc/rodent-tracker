/** Frame-indexed MP4 decoding with container presentation timestamps. */

import type { FrameSource, Timebase, TimingReport } from '../types';
import { describeTiming } from '../time';
import { sha256Bytes } from '../identity';

/** Minimal shape of what mp4box.js gives us, so this file typechecks alone. */
interface Mp4boxSample {
  cts: number;
  dts: number;
  is_sync: boolean;
  data: Uint8Array;
  size: number;
}

interface Mp4boxTrack {
  id: number;
  codec: string;
  timescale: number;
  nb_samples: number;
  video?: { width: number; height: number };
}

interface Mp4boxInfo {
  videoTracks: Mp4boxTrack[];
}

interface Mp4boxFile {
  onReady: (info: Mp4boxInfo) => void;
  onError: (e: string) => void;
  onSamples: (id: number, user: unknown, samples: Mp4boxSample[]) => void;
  appendBuffer: (buf: ArrayBuffer & { fileStart: number }) => void;
  flush: () => void;
  setExtractionOptions: (id: number, user: unknown, opts: { nbSamples: number }) => void;
  start: () => void;
  stop: () => void;
  getTrackById: (id: number) => unknown;
}

export class UnsupportedBrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedBrowserError';
  }
}

export class VideoDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoDecodeError';
  }
}

/** Whether this browser can run the tool at all. Checked before a file is asked for. */
export function checkVideoSupport(): { supported: boolean; reason: string } {
  if (typeof VideoDecoder === 'undefined') {
    return {
      supported: false,
      reason:
        'This browser does not support frame-accurate video decoding. Use a current version of Chrome or Edge.',
    };
  }
  return { supported: true, reason: '' };
}

/** The subset of a container sample that the index actually needs. */
export interface SampleInfo {
  readonly cts: number;
  readonly is_sync: boolean;
}

export interface DecodedIndex<T extends SampleInfo = SampleInfo> {
  /** Samples in decode order, as the container stores them. */
  readonly samples: ReadonlyArray<T>;
  /** Presentation index of each sample: the inverse of `presentationOrder`. */
  readonly presentationIndexOfSample: Int32Array;
  /** Sample indices sorted by presentation timestamp. */
  readonly presentationOrder: ReadonlyArray<number>;
  /** Presentation indices that are keyframes, ascending. */
  readonly keyframePresentationIndices: ReadonlyArray<number>;
}

export class WebCodecsFrameSource implements FrameSource {
  readonly sourceSha256: string;
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly timebase: Timebase;
  readonly timing: TimingReport;
  /** Median gap between keyframes, in frames. Governs how fast seeking is. */
  readonly keyframeInterval: number;

  private readonly index: DecodedIndex<Mp4boxSample>;
  private readonly codec: string;
  private readonly description: Uint8Array | undefined;
  private cache = new Map<number, Uint8Array>();
  /** Bounded so that a long video cannot exhaust memory during scrubbing. */
  private readonly cacheLimit = 45;
  /** WebCodecs hardware decoders are not reliably re-entrant on every machine. */
  private decodeTail: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(init: {
    sourceSha256: string;
    width: number;
    height: number;
    timebase: Timebase;
    timing: TimingReport;
    index: DecodedIndex<Mp4boxSample>;
    codec: string;
    description: Uint8Array | undefined;
    keyframeInterval: number;
  }) {
    this.sourceSha256 = init.sourceSha256;
    this.width = init.width;
    this.height = init.height;
    this.timebase = init.timebase;
    this.timing = init.timing;
    this.frameCount = init.timebase.ptsTicks.length;
    this.index = init.index;
    this.codec = init.codec;
    this.description = init.description;
    this.keyframeInterval = init.keyframeInterval;
  }

  /**
   * Demux a file and build the frame index.
   *
   * The whole file is held in memory. For the recordings this tool is for —
   * 640x480, a few minutes, single-digit megabytes — that is the simple choice
   * and it is fine. A very large file will be reported rather than silently
   * exhausting memory.
   */
  static async fromFile(file: Blob, mp4boxModule: unknown): Promise<WebCodecsFrameSource> {
    const support = checkVideoSupport();
    if (!support.supported) throw new UnsupportedBrowserError(support.reason);

    const mp4box = mp4boxModule as {
      createFile: () => Mp4boxFile;
      DataStream: new (b?: unknown, o?: number, e?: unknown) => { buffer: ArrayBuffer; endianness: unknown };
    } & { DataStream: { BIG_ENDIAN: unknown } };

    const maxBytes = 256 * 1024 * 1024;
    if (file.size > maxBytes) {
      throw new VideoDecodeError('This recording is over 256 MB. Trim or convert it before loading it here.');
    }
    const buffer = await file.arrayBuffer();
    const sourceSha256 = await sha256Bytes(buffer);
    const mp4 = mp4box.createFile();

    const samples: Mp4boxSample[] = [];
    let track: Mp4boxTrack | null = null;
    let failure: string | null = null;

    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (work: () => void) => {
        if (settled) return;
        settled = true;
        if (readyTimer) clearTimeout(readyTimer);
        readyTimer = null;
        work();
      };
      readyTimer = setTimeout(
        () => finish(() => reject(new VideoDecodeError('Reading the MP4 timed out. Convert it to H.264 MP4 and try again.'))),
        60_000,
      );
      mp4.onError = (e) => {
        failure = e;
        finish(() => reject(new VideoDecodeError(`This file could not be read as an MP4: ${e}`)));
      };
      mp4.onReady = (info) => {
        const first = info.videoTracks?.[0];
        if (!first) {
          finish(() => reject(
            new VideoDecodeError(
              'No video track found. Convert the recording to an H.264 MP4 and try again.',
            ),
          ));
          return;
        }
        if (first.nb_samples <= 0) {
          finish(() => reject(new VideoDecodeError('This video contains no frames.')));
          return;
        }
        track = first;
        mp4.setExtractionOptions(first.id, null, { nbSamples: Number.POSITIVE_INFINITY });
        mp4.onSamples = (_id, _user, batch) => {
          for (const s of batch) samples.push(s);
          if (track && samples.length >= track.nb_samples) finish(resolve);
        };
        mp4.start();
      };
    });

    const withStart = buffer as ArrayBuffer & { fileStart: number };
    withStart.fileStart = 0;
    try {
      mp4.appendBuffer(withStart);
      mp4.flush();
      await ready;
    } finally {
      if (readyTimer) clearTimeout(readyTimer);
      mp4.stop();
    }

    if (failure) throw new VideoDecodeError(`This file could not be read as an MP4: ${failure}`);
    if (!track) throw new VideoDecodeError('No video track was found in this file.');
    const t = track as Mp4boxTrack;
    if (samples.length === 0) throw new VideoDecodeError('This video contains no frames.');

    const index = buildIndex(samples);
    // Zero-based, because every column this tool exports says "seconds from the
    // start of the recording". mp4box reports composition time without the
    // track's initial offset, which on these files is 1024 ticks (two frames)
    // ahead of what ffprobe reports. A constant offset cancels out of any
    // latency, but it would put a 0.067 s discrepancy into every absolute
    // timestamp depending on which decoder had read the file.
    const rawPts = index.presentationOrder.map((i) => samples[i]!.cts);
    const firstPts = rawPts.length ? rawPts[0]! : 0;
    const ptsTicks = rawPts.map((p) => p - firstPts);
    const timebase: Timebase = { timescale: t.timescale, ptsTicks };
    const timing = describeTiming(t.timescale, ptsTicks);

    const width = t.video?.width ?? 0;
    const height = t.video?.height ?? 0;
    if (!width || !height) throw new VideoDecodeError('This video does not report its dimensions.');

    const description = extractDescription(mp4, t.id, mp4box);
    const config: VideoDecoderConfig = {
      codec: t.codec,
      codedWidth: width,
      codedHeight: height,
      ...(description ? { description } : {}),
      optimizeForLatency: true,
    };
    const support2 = await VideoDecoder.isConfigSupported(config);
    if (!support2.supported) {
      throw new UnsupportedBrowserError(
        `Unsupported video codec: ${t.codec}. Convert the recording to an H.264 MP4.`,
      );
    }

    const gaps: number[] = [];
    for (let i = 1; i < index.keyframePresentationIndices.length; i++) {
      gaps.push(index.keyframePresentationIndices[i]! - index.keyframePresentationIndices[i - 1]!);
    }
    gaps.sort((a, b) => a - b);
    const keyframeInterval = gaps.length ? gaps[gaps.length >> 1]! : ptsTicks.length;

    return new WebCodecsFrameSource({
      sourceSha256,
      width,
      height,
      timebase,
      timing,
      index,
      codec: t.codec,
      description,
      keyframeInterval,
    });
  }

  async scan(
    range: { readonly from: number; readonly to: number; readonly only?: ReadonlySet<number> },
    visit: (frame: number, gray: Uint8Array) => void | Promise<void>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    if (this.closed) throw new VideoDecodeError('This video has been closed.');
    const from = Math.max(0, range.from);
    const to = Math.min(this.frameCount - 1, range.to);
    if (to < from) return;
    const { only } = range;
    const total = only ? [...only].filter((f) => f >= from && f <= to).length : to - from + 1;
    let done = 0;

    await this.withDecodeLock(async () => {
      // Reading a frame's pixels back from the decoder costs several times
      // more than decoding it, so frames nobody asked for are never read.
      const wants = only ? (frameIndex: number) => only.has(frameIndex) : undefined;
      await this.decodeRange(from, to, async (frameIndex, gray) => {
        if (this.closed) throw new VideoDecodeError('This video has been closed.');
        if (frameIndex < from || frameIndex > to) return;
        await visit(frameIndex, gray);
        done++;
        if (done % 50 === 0) onProgress?.(done, total);
      }, wants);
    });
    if (this.closed) throw new VideoDecodeError('This video has been closed.');
    onProgress?.(total, total);
  }

  /**
   * A single frame, with a small cache.
   *
   * The correction workflow steps through nearby frames, so a short cache
   * avoids repeated keyframe seeks without retaining a large image buffer.
   */
  async getGrayFrame(frame: number): Promise<Uint8Array> {
    if (this.closed) throw new VideoDecodeError('This video has been closed.');
    if (frame < 0 || frame >= this.frameCount) throw new RangeError(`frame ${frame} is out of range`);
    const hit = this.cache.get(frame);
    if (hit) return hit;

    return this.withDecodeLock(async () => {
      if (this.closed) throw new VideoDecodeError('This video has been closed.');
      // Another queued request may have decoded this frame while we waited.
      const queuedHit = this.cache.get(frame);
      if (queuedHit) return queuedHit;

      // Decode from the keyframe through a short run past the requested frame:
      // the frames either side are almost always wanted next, and they are nearly
      // free once the keyframe has been decoded.
      const lookahead = Math.min(this.frameCount - 1, frame + Math.min(30, this.keyframeInterval));
      await this.decodeRange(frame, lookahead, (i, gray) => {
        if (this.cache.size >= this.cacheLimit) {
          const oldest = this.cache.keys().next().value;
          if (oldest !== undefined) this.cache.delete(oldest);
        }
        this.cache.set(i, Uint8Array.from(gray));
      });

      const out = this.cache.get(frame);
      if (!out) throw new VideoDecodeError(`Frame ${frame} could not be decoded.`);
      return out;
    });
  }

  close(): void {
    this.closed = true;
    this.cache.clear();
  }

  /** Run at most one decoder for this video, even when scrub events overlap. */
  private async withDecodeLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.decodeTail;
    let unlock!: () => void;
    this.decodeTail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      unlock();
    }
  }

  /**
   * Decode a presentation range and hand each frame's luminance to a callback.
   *
   * Two details matter here. Decoding must start at a keyframe, so the run
   * begins at the last keyframe at or before the requested frame and the extra
   * frames are decoded and discarded. And samples must be fed in *decode* order
   * while the decoder emits in *presentation* order — these clips use B-frames,
   * so the two differ, and treating the nth decoded frame as the nth displayed
   * frame would shift positions against timestamps.
   */
  private async decodeRange(
    from: number,
    to: number,
    onFrame: (frameIndex: number, gray: Uint8Array) => void | Promise<void>,
    wants?: (frameIndex: number) => boolean,
  ): Promise<void> {
    const { samples, presentationOrder, presentationIndexOfSample, keyframePresentationIndices } = this.index;

    let keyframeIndex = 0;
    for (const k of keyframePresentationIndices) {
      if (k <= from) keyframeIndex = k;
      else break;
    }

    // Every sample needed: those whose presentation index falls in
    // [startPresentation, to], fed in decode order. A frame inside that
    // presentation window can sit later in decode order than the window's last
    // frame, so the decode range is the span of their decode indices.
    let firstSample = Number.POSITIVE_INFINITY;
    let lastSample = -1;
    for (let p = keyframeIndex; p <= to; p++) {
      const s = presentationOrder[p]!;
      if (s < firstSample) firstSample = s;
      if (s > lastSample) lastSample = s;
    }
    if (lastSample < 0) return;

    const outputPresentationIndices = presentationIndicesInDecodeSpan(
      presentationIndexOfSample,
      firstSample,
      lastSample,
    );
    const fedCount = lastSample - firstSample + 1;

    let decodeError: Error | null = null;
    const luma = new LumaReader(this.width, this.height);

    // Frames are handled one at a time on a promise chain rather than collected
    // into a list. Two reasons, both of which bit an earlier version of this
    // file: reading a frame's pixels is asynchronous, so the callback cannot do
    // it inline; and the luminance reader writes into one reused buffer, so
    // holding several frames at once would leave every one of them pointing at
    // the last frame's pixels.
    let chain: Promise<void> = Promise.resolve();
    /**
     * Frames are numbered by matching the decoder's presentation-order outputs
     * to the presentation indices of the samples actually fed.
     *
     * The lookup approach is the obvious one and it is wrong on exactly these
     * files. All three sample clips contain frames that share a presentation
     * timestamp with their neighbor -- 162 of them in `test50` -- so a
     * timestamp maps to two different frames and the second one resolves to the
     * index of the first. An earlier version did that and then correctly
     * complained that the decoder had returned frame 162 twice. The decoder was
     * behaving; the numbering was not.
     *
     * The fed samples are contiguous in decode order, but their presentation
     * indices need not be contiguous around B-frame lookahead boundaries. The
     * sorted index list preserves duplicate timestamps without assuming away
     * those gaps. The count is checked after the run finishes.
     */
    let emitted = 0;

    const decoder = new VideoDecoder({
      output: (frame) => {
        chain = chain
          .then(async () => {
            try {
              if (this.closed) throw new VideoDecodeError('This video has been closed.');
              const p = outputPresentationIndices[emitted];
              emitted++;
              if (p === undefined || p >= this.frameCount) return;
              if (wants && !wants(p)) return;
              await onFrame(p, await luma.read(frame));
            } finally {
              frame.close();
            }
          })
          .catch((e: unknown) => {
            decodeError ??= e as Error;
          });
      },
      error: (e) => {
        decodeError ??= new VideoDecodeError(`Decoding failed: ${e.message}`);
      },
    });

    decoder.configure({
      codec: this.codec,
      codedWidth: this.width,
      codedHeight: this.height,
      ...(this.description ? { description: this.description } : {}),
      optimizeForLatency: true,
    });

    try {
      for (let s = firstSample; s <= lastSample; s++) {
        if (this.closed) throw new VideoDecodeError('This video has been closed.');
        const sample = samples[s]!;
        if (decodeError) break;
        decoder.decode(
          new EncodedVideoChunk({
            type: sample.is_sync ? 'key' : 'delta',
            timestamp: Math.round((sample.cts / this.timebase.timescale) * 1_000_000),
            duration: 0,
            data: sample.data,
          }),
        );
        // Keep the queue short so memory stays flat on a long clip: without
        // this, a three-minute video queues every frame at once.
        if (decoder.decodeQueueSize > 24) {
          await new Promise<void>((r) => {
            decoder.addEventListener('dequeue', () => r(), { once: true });
          });
          await chain;
          if (this.closed) throw new VideoDecodeError('This video has been closed.');
        }
      }
      if (!decodeError) await decoder.flush();
      await chain;
    } finally {
      if (decoder.state !== 'closed') decoder.close();
    }

    if (decodeError) throw decodeError;
    if (this.closed) throw new VideoDecodeError('This video has been closed.');

    // A decoder that quietly drops a frame would shift every position after it
    // against its timestamp, which is the kind of error that produces a
    // plausible wrong answer rather than an obvious one.
    if (emitted !== fedCount) {
      throw new VideoDecodeError(
        `Decoder returned ${emitted} of ${fedCount} frames. Timestamps cannot be aligned reliably. Try Chrome or Edge.`,
      );
    }
  }
}

/**
 * Read the luminance plane out of a decoded frame.
 *
 * The source is a grayscale camera, so luminance is all the information there
 * is. For an I420 frame the Y plane is exactly that and can be copied straight
 * out with no color conversion at all. Frames that arrive in some other layout
 * — a hardware decoder may hand back something else — go the long way round
 * through a canvas.
 */
class LumaReader {
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private readonly out: Uint8Array;
  private planar: Uint8Array | null = null;
  /**
   * Limited-range to full-range lookup, built once.
   *
   * Video Y is normally studio range: black at 16, white at 235, not 0 and 255.
   * The raw plane therefore has about 14% less contrast than the same frame has
   * once a player or a converter has expanded it, and a detector threshold in
   * gray levels means different things in the two.
   *
   * This is not a hypothetical. The dev-side harness reads frames through
   * ffmpeg, which expands the range, while this decoder was handing back the raw
   * plane. Identical code on an identical file produced blobs about 4% smaller
   * in the browser than in the harness, which was enough to move an escape-hole
   * suggestion from one hole to another and flip a trial's search strategy from
   * serial to spatial. Expanding here makes the two agree exactly: the table
   * below reproduces ffmpeg's `format=gray` output with a maximum difference of
   * zero across a frame.
   */
  private static readonly EXPAND = (() => {
    const table = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
      table[v] = Math.max(0, Math.min(255, Math.round(((v - 16) * 255) / 219)));
    }
    return table;
  })();

  constructor(private readonly width: number, private readonly height: number) {
    this.out = new Uint8Array(width * height);
  }

  /**
   * The returned buffer is reused on the next call. Copy it to keep it.
   */
  async read(frame: VideoFrame): Promise<Uint8Array> {
    const format = frame.format ?? '';
    if (format.startsWith('I420') || format === 'NV12' || format.startsWith('I422') || format.startsWith('I444')) {
      const size = frame.allocationSize();
      if (!this.planar || this.planar.length < size) this.planar = new Uint8Array(size);
      // copyTo resolves once the pixels are actually in the buffer, which for a
      // GPU-backed frame means after a readback. Awaiting it is not optional:
      // reading the buffer synchronously returns whatever was there before.
      const layout = await frame.copyTo(this.planar);
      // Plane 0 of every YUV layout WebCodecs defines is the luminance plane,
      // and its stride can exceed the visible width.
      const plane = layout[0];
      const stride = plane?.stride ?? this.width;
      const offset = plane?.offset ?? 0;
      // Expand studio range unless the file says it is already full range.
      // `colorSpace.fullRange` is null when the container does not say, which
      // for H.264 means studio range by convention, and is the case for these
      // recordings.
      const expand = frame.colorSpace?.fullRange !== true;
      const table = LumaReader.EXPAND;
      for (let y = 0; y < this.height; y++) {
        const src = offset + y * stride;
        const dst = y * this.width;
        if (expand) {
          for (let x = 0; x < this.width; x++) this.out[dst + x] = table[this.planar[src + x]!]!;
        } else {
          this.out.set(this.planar.subarray(src, src + this.width), dst);
        }
      }
      return this.out;
    }
    return this.readViaCanvas(frame);
  }

  private readViaCanvas(frame: VideoFrame): Uint8Array {
    this.canvas ??= new OffscreenCanvas(this.width, this.height);
    this.ctx ??= this.canvas.getContext('2d', { willReadFrequently: true });
    if (!this.ctx) throw new VideoDecodeError('Could not read pixels from this video.');
    this.ctx.drawImage(frame, 0, 0, this.width, this.height);
    const data = this.ctx.getImageData(0, 0, this.width, this.height).data;
    for (let i = 0, p = 0; i < this.out.length; i++, p += 4) {
      // Rec. 601 luma. The camera is grayscale so the channels agree, but this
      // is correct either way.
      this.out[i] = (data[p]! * 77 + data[p + 1]! * 150 + data[p + 2]! * 29) >> 8;
    }
    return this.out;
  }
}

/**
 * Build the presentation index from the container's sample table.
 *
 * Exported so it can be tested without a browser: the reordering is the part
 * most likely to be subtly wrong, and it needs no decoder to check.
 */
export function buildIndex<T extends SampleInfo>(samples: ReadonlyArray<T>): DecodedIndex<T> {
  const order = samples.map((_s, i) => i).sort((a, b) => samples[a]!.cts - samples[b]!.cts || a - b);
  const inverse = new Int32Array(samples.length);
  order.forEach((sampleIndex, presentationIndex) => {
    inverse[sampleIndex] = presentationIndex;
  });
  const keyframes: number[] = [];
  order.forEach((sampleIndex, presentationIndex) => {
    if (samples[sampleIndex]!.is_sync) keyframes.push(presentationIndex);
  });
  // A file whose first frame is not marked as a keyframe cannot be decoded from
  // anywhere else, so treat frame 0 as one.
  if (keyframes[0] !== 0) keyframes.unshift(0);
  return {
    samples,
    presentationOrder: order,
    presentationIndexOfSample: inverse,
    keyframePresentationIndices: keyframes,
  };
}

/** Presentation indices emitted for a contiguous span of decode-order samples. */
export function presentationIndicesInDecodeSpan(
  presentationIndexOfSample: ArrayLike<number>,
  firstSample: number,
  lastSample: number,
): number[] {
  const indices: number[] = [];
  for (let sample = firstSample; sample <= lastSample; sample++) {
    indices.push(presentationIndexOfSample[sample]!);
  }
  return indices.sort((a, b) => a - b);
}

/** The codec-private data a decoder needs (`avcC` for H.264, `hvcC` for H.265). */
function extractDescription(
  mp4: Mp4boxFile,
  trackId: number,
  mp4box: { DataStream: new (b?: unknown, o?: number, e?: unknown) => { buffer: ArrayBuffer } } & {
    DataStream: { BIG_ENDIAN: unknown };
  },
): Uint8Array | undefined {
  const trak = mp4.getTrackById(trackId) as {
    mdia?: { minf?: { stbl?: { stsd?: { entries?: Record<string, { write?: (s: unknown) => void }>[] } } } };
  };
  const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
  if (!entry) return undefined;
  const box = (entry as Record<string, unknown>).avcC ?? (entry as Record<string, unknown>).hvcC;
  if (!box || typeof (box as { write?: unknown }).write !== 'function') return undefined;
  const stream = new mp4box.DataStream(undefined, 0, mp4box.DataStream.BIG_ENDIAN);
  (box as { write: (s: unknown) => void }).write(stream);
  // Strip the eight-byte box header; the decoder wants the payload only.
  return new Uint8Array(stream.buffer, 8);
}
