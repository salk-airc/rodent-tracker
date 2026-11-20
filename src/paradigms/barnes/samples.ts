/**
 * The three sample Barnes maze recordings. They are not kept in this repo:
 * they are the clips published with the AIRC RSE take-home, and
 * `ensureSampleClips` downloads them from there, pinned to one commit and
 * checked against these SHA-256 hashes (`sampleFiles.ts`, Node only; this
 * file has no Node imports, so a web app can use it too). The committed results in
 * `outputs/barnes/` were generated from these exact files.
 */

/** The sample recordings, by file stem. */
export const SAMPLE_CLIPS = ['test50', 'test51', 'test53'] as const;
export type SampleClip = (typeof SAMPLE_CLIPS)[number];

/** Where the clips are published. */
export const SAMPLE_SOURCE = {
  repo: 'salk-airc/rse-takehome-2026',
  commit: 'ce7b84c95bc59dc73cc7ff120826cc9bf1c6935f',
  path: 'data/barnes-maze',
} as const;

export const SAMPLE_SHA256: Readonly<Record<SampleClip, string>> = {
  test50: '654e98559f5a81b964316487a457b206915a3ad9b084c7944c1afda3186fff87',
  test51: '6e62674589c8915fa6b6cf1fc78ba8e9a0b29fec6086817d6ad2dd14493a6743',
  test53: '351e85627241debbe7b2624d84e1c7ce97086db04fed215305019cb358d4d571',
};

/** The folder the tools and tests read the clips from, relative to a repo root. */
export const SAMPLE_DIR = 'data/barnes-maze';

export function sampleUrl(clip: SampleClip): string {
  const { repo, commit, path } = SAMPLE_SOURCE;
  return `https://raw.githubusercontent.com/${repo}/${commit}/${path}/${clip}.mp4`;
}
