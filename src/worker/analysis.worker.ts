/** Runs decoding and analysis outside the UI thread. */

import MP4Box from 'mp4box';
import { WebCodecsFrameSource, UnsupportedBrowserError, VideoDecodeError } from '../video/webcodecs';
import { analyzeVideo } from '../pipeline';
import { buildBackground } from '../geometry/background';
import { packObservations } from '../project/schema';
import { videoMeasurementBasis } from '../measurementBasis';
import type { WorkerRequest, WorkerResponse } from './protocol';

interface OpenVideo {
  readonly file: Blob;
  readonly fileName: string;
  readonly fileSize: number | null;
  readonly width: number;
  readonly height: number;
  source: WebCodecsFrameSource | null;
  opening: Promise<WebCodecsFrameSource> | null;
  busy: number;
  closed: boolean;
  background: Uint8Array | null;
}

const open = new Map<string, OpenVideo>();
const openingTokens = new Map<string, symbol>();
let previewVideoId: string | null = null;

function reply(message: WorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfer);
}

/** Add operation context to worker errors. */
function describeFailure(e: unknown, doing: string): { message: string; fatal: boolean } {
  if (e instanceof UnsupportedBrowserError) return { message: e.message, fatal: true };
  if (e instanceof VideoDecodeError) return { message: e.message, fatal: false };
  if (e instanceof RangeError) return { message: `${doing}: ${e.message}`, fatal: false };
  const detail = e instanceof Error ? e.message : String(e);
  return {
    message: `Failed while ${doing}: ${detail}. Try another MP4 or reload the page.`,
    fatal: false,
  };
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    switch (request.type) {
      case 'open':
        await handleOpen(request.videoId, request.file, fileNameOf(request.file));
        break;
      case 'analyze':
        await handleAnalyze(request);
        break;
      case 'frame':
        await handleFrame(request);
        break;
      case 'background':
        await handleBackground(request.videoId, request.requestId);
        break;
      case 'release': {
        const entry = open.get(request.videoId);
        if (entry?.source && entry.busy === 0) releaseSource(entry, entry.source);
        if (previewVideoId === request.videoId) previewVideoId = null;
        break;
      }
      case 'close': {
        openingTokens.delete(request.videoId);
        const entry = open.get(request.videoId);
        if (entry) {
          entry.closed = true;
          entry.source?.close();
        }
        open.delete(request.videoId);
        if (previewVideoId === request.videoId) previewVideoId = null;
        break;
      }
    }
  } catch (e) {
    if (
      request.type !== 'open' &&
      request.type !== 'close' &&
      request.type !== 'release' &&
      !open.has(request.videoId)
    ) return;
    const { message, fatal } = describeFailure(e, describeRequest(request));
    if (request.type === 'frame') {
      reply({
        type: 'frameFailed',
        requestId: request.requestId,
        videoId: request.videoId,
        frame: request.frame,
        message,
      });
    } else if (request.type === 'background') {
      reply({
        type: 'backgroundFailed',
        requestId: request.requestId,
        videoId: request.videoId,
        message,
      });
    } else {
      reply({ type: 'failed', videoId: 'videoId' in request ? request.videoId : '', message, fatal });
    }
  }
};

function describeRequest(request: WorkerRequest): string {
  switch (request.type) {
    case 'open':
      return 'opening the video';
    case 'analyze':
      return 'analyzing the video';
    case 'frame':
      return `reading frame ${request.frame}`;
    case 'background':
      return 'building the reference image';
    case 'release':
      return 'releasing the video preview';
    case 'close':
      return 'closing the video';
  }
}

function fileNameOf(file: Blob): string {
  return file instanceof File && file.name ? file.name : 'video.mp4';
}

async function handleOpen(videoId: string, file: Blob, fileName: string): Promise<void> {
  const token = Symbol(videoId);
  openingTokens.set(videoId, token);
  const previous = open.get(videoId);
  if (previous) {
    previous.closed = true;
    previous.source?.close();
  }
  if (previewVideoId === videoId) previewVideoId = null;
  let source: WebCodecsFrameSource;
  try {
    source = await WebCodecsFrameSource.fromFile(file, MP4Box);
  } catch (error) {
    if (openingTokens.get(videoId) === token) openingTokens.delete(videoId);
    throw error;
  }
  if (openingTokens.get(videoId) !== token) {
    source.close();
    return;
  }
  openingTokens.delete(videoId);
  open.set(videoId, {
    file,
    source,
    opening: null,
    busy: 0,
    closed: false,
    fileName,
    fileSize: file.size ?? null,
    width: source.width,
    height: source.height,
    background: null,
  });
  reply({
    type: 'opened',
    video: {
      sourceSha256: source.sourceSha256,
      videoId,
      fileName,
      fileSize: file.size ?? null,
      width: source.width,
      height: source.height,
      frameCount: source.frameCount,
      timebase: { timescale: source.timebase.timescale, ptsTicks: source.timebase.ptsTicks },
      timing: source.timing,
      keyframeInterval: source.keyframeInterval,
    },
  });
}

async function handleAnalyze(request: Extract<WorkerRequest, { type: 'analyze' }>): Promise<void> {
  const entry = open.get(request.videoId);
  if (!entry) throw new VideoDecodeError('That video is not open any more. Load it again.');
  entry.busy++;
  let source: WebCodecsFrameSource | null = null;
  try {
    source = await ensureSource(entry);
    const observations = await analyzeVideo(request.videoId, source, {
      params: request.params,
      ...(request.template ? { template: request.template } : {}),
      ...(request.geometry ? { geometry: request.geometry } : {}),
      onProgress: (stage, done, total) => {
        if (open.get(request.videoId) === entry && !entry.closed) {
          reply({ type: 'progress', videoId: request.videoId, stage, done, total });
        }
      },
    });

    if (open.get(request.videoId) !== entry || entry.closed) return;

    entry.background = observations.backgroundImage.data;

    reply({
      type: 'analyzed',
      result: {
        videoId: request.videoId,
        rigId: request.template?.id ?? null,
        geometry: observations.geometry,
        measurementBasis: videoMeasurementBasis(request.params, observations.geometry),
        observations: packObservations(observations.observations),
        bodyAreaPx: observations.bodyAreaPx,
        bodyAreaSpread: observations.bodyAreaSpread,
        detectedTrialStart: observations.detectedTrialStart,
        notes: observations.notes,
      },
    });
  } finally {
    entry.busy--;
    if (source) releaseSource(entry, source);
  }
}

async function handleFrame(request: Extract<WorkerRequest, { type: 'frame' }>): Promise<void> {
  const entry = open.get(request.videoId);
  if (!entry) throw new VideoDecodeError('That video is not open any more. Load it again.');
  if (previewVideoId !== request.videoId) {
    for (const [videoId, opened] of open) {
      if (videoId !== request.videoId && opened.busy === 0 && opened.source) releaseSource(opened, opened.source);
    }
    previewVideoId = request.videoId;
  }
  entry.busy++;
  let source: WebCodecsFrameSource | null = null;
  try {
    source = await ensureSource(entry);
    const gray = await source.getGrayFrame(request.frame);
    if (open.get(request.videoId) !== entry || entry.closed) return;
    // A copy, because the decoder's cache holds the original and transferring it
    // would detach the buffer the cache is relying on.
    const copy = Uint8Array.from(gray);
    reply(
      {
        type: 'frameData',
        requestId: request.requestId,
        videoId: request.videoId,
        frame: request.frame,
        gray: copy,
        width: entry.width,
        height: entry.height,
      },
      [copy.buffer],
    );
  } finally {
    entry.busy--;
    if (source && previewVideoId !== request.videoId) releaseSource(entry, source);
  }
}

async function handleBackground(videoId: string, requestId: number): Promise<void> {
  const entry = open.get(videoId);
  if (!entry) throw new VideoDecodeError('That video is not open any more. Load it again.');
  if (!entry.background) {
    entry.busy++;
    let source: WebCodecsFrameSource | null = null;
    try {
      source = await ensureSource(entry);
      const bg = await buildBackground(source, 41, 0.8, (done, total) =>
        open.get(videoId) === entry && !entry.closed
          ? reply({ type: 'progress', videoId, stage: 'background', done, total })
          : undefined,
      );
      if (open.get(videoId) !== entry || entry.closed) return;
      entry.background = bg.image.data;
    } finally {
      entry.busy--;
      if (source) releaseSource(entry, source);
    }
  }
  if (open.get(videoId) !== entry || entry.closed || !entry.background) return;
  const copy = Uint8Array.from(entry.background);
  reply(
    { type: 'backgroundData', requestId, videoId, gray: copy, width: entry.width, height: entry.height },
    [copy.buffer],
  );
}

async function ensureSource(entry: OpenVideo): Promise<WebCodecsFrameSource> {
  if (entry.closed) throw new VideoDecodeError('That video is not open any more. Load it again.');
  if (entry.source) return entry.source;
  if (!entry.opening) entry.opening = WebCodecsFrameSource.fromFile(entry.file, MP4Box);
  try {
    const source = await entry.opening;
    if (entry.closed) {
      source.close();
      throw new VideoDecodeError('That video is not open any more. Load it again.');
    }
    entry.source = source;
    return source;
  } finally {
    entry.opening = null;
  }
}

function releaseSource(entry: OpenVideo, source: WebCodecsFrameSource): void {
  if (entry.source !== source || entry.busy > 0) return;
  source.close();
  entry.source = null;
}
