import type { ProjectFile } from '../../src/project/schema';

/**
 * The sample project with every input confirmed, and the first recording's
 * stored trial start moved off `startFrame`, so a test can tell the recomputed
 * start from the stored one.
 */
export function confirmedSample(file: ProjectFile, startFrame: number): ProjectFile {
  return {
    ...file,
    videos: file.videos.map((video, index) => ({
      ...video,
      mazeConfirmed: true,
      geometry: {
        ...video.geometry,
        platformDiameterSource: 'manual' as const,
        targetProvenance: 'manual' as const,
      },
      detectedTrialStart: index === 0
        ? { ...video.detectedTrialStart, frame: startFrame === 0 ? 1 : 0 }
        : video.detectedTrialStart,
    })),
  };
}
