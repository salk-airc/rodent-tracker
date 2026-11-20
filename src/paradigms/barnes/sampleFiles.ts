/** Download and check the sample clips on disk (Node only; see `samples.ts`). */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SAMPLE_CLIPS, SAMPLE_DIR, SAMPLE_SHA256, sampleUrl } from './samples';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** True when every clip is in `dir` with the expected contents. */
export function haveSampleClips(dir = SAMPLE_DIR): boolean {
  return SAMPLE_CLIPS.every((clip) => {
    const file = join(dir, `${clip}.mp4`);
    return existsSync(file) && sha256(readFileSync(file)) === SAMPLE_SHA256[clip];
  });
}

/**
 * Download any clip that is missing from `dir` or has the wrong contents.
 * Throws if a download fails or does not match its hash.
 */
export async function ensureSampleClips(dir = SAMPLE_DIR, log: (line: string) => void = () => {}): Promise<void> {
  mkdirSync(dir, { recursive: true });
  for (const clip of SAMPLE_CLIPS) {
    const file = join(dir, `${clip}.mp4`);
    if (existsSync(file) && sha256(readFileSync(file)) === SAMPLE_SHA256[clip]) continue;
    const url = sampleUrl(clip);
    log(`downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`could not download ${url}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const got = sha256(bytes);
    if (got !== SAMPLE_SHA256[clip]) throw new Error(`${url} has SHA-256 ${got}, expected ${SAMPLE_SHA256[clip]}`);
    writeFileSync(file, bytes);
  }
}
