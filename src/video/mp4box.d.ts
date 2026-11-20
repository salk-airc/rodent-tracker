/**
 * Types for mp4box.js, which ships without any.
 *
 * Only the parts this project uses are declared. The alternative — an `any`
 * import — would silently swallow a typo in the one place where a mistake
 * produces a plausible-looking but wrong frame index.
 */
declare module 'mp4box' {
  export interface MP4Sample {
    cts: number;
    dts: number;
    is_sync: boolean;
    size: number;
    data: Uint8Array;
  }

  export interface MP4VideoTrack {
    id: number;
    codec: string;
    timescale: number;
    duration: number;
    nb_samples: number;
    video?: { width: number; height: number };
  }

  export interface MP4Info {
    videoTracks: MP4VideoTrack[];
    audioTracks: unknown[];
  }

  export interface MP4File {
    onReady: (info: MP4Info) => void;
    onError: (message: string) => void;
    onSamples: (trackId: number, user: unknown, samples: MP4Sample[]) => void;
    appendBuffer: (buffer: ArrayBuffer & { fileStart: number }) => void;
    flush: () => void;
    start: () => void;
    stop: () => void;
    setExtractionOptions: (trackId: number, user: unknown, options: { nbSamples: number }) => void;
    getTrackById: (trackId: number) => unknown;
  }

  export class DataStream {
    constructor(buffer?: ArrayBuffer, byteOffset?: number, endianness?: boolean);
    static readonly BIG_ENDIAN: boolean;
    static readonly LITTLE_ENDIAN: boolean;
    buffer: ArrayBuffer;
  }

  export function createFile(): MP4File;
}
