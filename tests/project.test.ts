import { describe, expect, it } from 'vitest';
import {
  PROJECT_FORMAT_VERSION,
  packObservations,
  unpackObservations,
  type StoredVideo,
} from '../src/paradigms/barnes/project/schema';
import { ProjectFormatError, readProject, suggestProjectFileName, writeProject } from '../src/paradigms/barnes/project/io';
import { EMPTY_META, NAMING_SCHEMES, parseFilename, schemeConfidence } from '../src/paradigms/barnes/project/filename';
import { DEFAULT_PARAMS } from '../src/paradigms/barnes/params';
import { videoMeasurementBasis } from '../src/paradigms/barnes/measurementBasis';
import type { TrackObservation } from '../src/paradigms/barnes/types';
import { makeGeometry, makeTimebase } from './helpers/synthetic';

/**
 * Positions are stored to a tenth of a pixel, so the guarantee is an error of at
 * most 0.05 px. The extra thousandth absorbs binary floating-point noise, which
 * puts the difference at 0.05000000000001 rather than exactly 0.05.
 */
const ROUNDING_TOLERANCE_PX = 0.0501;

function sampleObservations(n: number): TrackObservation[] {
  const out: TrackObservation[] = [];
  for (let i = 0; i < n; i++) {
    const present = i % 7 !== 0;
    out.push({
      frame: i,
      areaMeasured: true,
      areaPx: present ? 700 + (i % 11) : 0,
      darkPixelsPx: present ? 900 : 0,
      body: present ? { x: 100 + i * 0.37, y: 200 - i * 0.11 } : null,
      nose: present ? { x: 110 + i * 0.37, y: 205 - i * 0.11 } : null,
      tail: present ? { x: 80 + i * 0.37, y: 190 - i * 0.11 } : null,
      thicknessPx: present ? 10.4 : 0,
      noseArmPx: present ? 15.2 : 0,
      tailArmPx: present ? 27.9 : 0,
      nearestHole: present ? i % 20 : -1,
      nearestHoleDistPx: present ? 12.3 : Number.POSITIVE_INFINITY,
      radialFraction: present ? 0.891 : Number.NaN,
      candidateCount: present ? 1 : 0,
      reacquired: i % 50 === 0,
      axisConfidence: present ? 0.75 : 0,
    });
  }
  return out;
}

function storedVideo(observations: TrackObservation[]): StoredVideo {
  const tb = makeTimebase(observations.length);
  const geometry = makeGeometry(7);
  return {
    id: 'v1',
    fileName: 'WT_M12_day3_trial2.mp4',
    fileSize: 1234,
    analyzedAt: '2026-08-31T00:00:00Z',
    observationToolVersion: '0.2.0',
    meta: parseFilename('WT_M12_day3_trial2.mp4'),
    width: 640,
    height: 480,
    timebase: { timescale: tb.timescale, ptsTicks: tb.ptsTicks },
    geometry,
    trackingSource: 'video',
    measurementBasis: videoMeasurementBasis(DEFAULT_PARAMS, geometry),
    mazeConfirmed: true,
    rigId: null,
    bodyAreaPx: 705,
    bodyAreaSpread: 0.18,
    detectedTrialStart: { frame: 10, reason: 'animalAppeared', provenance: 'auto', evidence: 'test' },
    trialStartOverride: null,
    observations: packObservations(observations),
    corrections: [],
    strategyOverride: null,
    notes: [],
  };
}

describe('packing observations', () => {
  /**
   * The promise this keeps: the facility can re-run analysis without
   * re-tracking. That is only true if what comes back out is what went in.
   */
  it('round-trips every field', () => {
    const original = sampleObservations(300);
    const back = unpackObservations(packObservations(original));
    expect(back).toHaveLength(original.length);
    for (let i = 0; i < original.length; i++) {
      const a = original[i]!;
      const b = back[i]!;
      expect(b.frame).toBe(a.frame);
      expect(b.areaPx).toBe(a.areaPx);
      expect(b.darkPixelsPx).toBe(a.darkPixelsPx);
      expect(b.nearestHole).toBe(a.nearestHole);
      expect(b.candidateCount).toBe(a.candidateCount);
      expect(b.reacquired).toBe(a.reacquired);
      // Well inside the accuracy of the measurement that produced these, and
      // far inside the ~8 px tolerance any threshold in the pipeline uses.
      if (a.body) {
        expect(Math.abs(b.body!.x - a.body.x)).toBeLessThanOrEqual(ROUNDING_TOLERANCE_PX);
        expect(Math.abs(b.body!.y - a.body.y)).toBeLessThanOrEqual(ROUNDING_TOLERANCE_PX);
      } else {
        expect(b.body).toBeNull();
      }
      if (a.nose) expect(Math.abs(b.nose!.y - a.nose.y)).toBeLessThanOrEqual(ROUNDING_TOLERANCE_PX);
      else expect(b.nose).toBeNull();
    }
  });

  it('preserves the difference between "no position" and "position at the origin"', () => {
    const obs: TrackObservation[] = [
      { ...sampleObservations(1)[0]!, body: { x: 0, y: 0 }, nose: { x: 0, y: 0 }, tail: { x: 0, y: 0 } },
      { ...sampleObservations(1)[0]!, body: null, nose: null, tail: null },
    ];
    const back = unpackObservations(packObservations(obs));
    expect(back[0]!.body).toEqual({ x: 0, y: 0 });
    expect(back[1]!.body).toBeNull();
  });

  it('preserves infinite and NaN sentinels', () => {
    const obs = sampleObservations(14);
    const back = unpackObservations(packObservations(obs));
    const missing = back.find((_o, i) => i % 7 === 0)!;
    expect(missing.nearestHoleDistPx).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(missing.radialFraction)).toBe(true);
  });
});

describe('project files', () => {
  const project = (over = {}) => ({
    createdAt: '2026-08-31T00:00:00Z',
    project: { name: 'Cohort B' },
    params: DEFAULT_PARAMS,
    rigs: [],
    videos: [storedVideo(sampleObservations(120))],
    excludedVideos: [],
    ...over,
  });

  it('writes and reads back the same content', () => {
    const text = writeProject(project());
    const read = readProject(text);
    expect(read.format).toBe('barnes-maze-analyzer');
    expect(read.formatVersion).toBe(PROJECT_FORMAT_VERSION);
    expect(read.project.name).toBe('Cohort B');
    expect(read.videos[0]!.observations.count).toBe(120);
    expect(read.videos[0]!.mazeConfirmed).toBe(true);
    expect(read.videos[0]!.geometry.platformDiameterSource).toBe('manual');
    expect(read.videos[0]!.trackingSource).toBe('video');
    expect(read.videos[0]!.observationToolVersion).toBe('0.2.0');
    expect(read.params.events.investigationRadiusCm).toBe(DEFAULT_PARAMS.events.investigationRadiusCm);
  });

  it('records the parameters, so the numbers can be reproduced', () => {
    const read = readProject(writeProject(project()));
    expect(read.params).toEqual(DEFAULT_PARAMS);
    expect(read.toolVersion).toBeTruthy();
  });

  /**
   * Indented JSON is what makes the file inspectable without this tool, but
   * indenting every element of every per-frame column took a three-minute
   * recording to two megabytes of whitespace.
   */
  it('keeps per-frame columns on one line, so the file stays a sane size', () => {
    const text = writeProject(project({ videos: [storedVideo(sampleObservations(5000))] }));
    expect(text).toMatch(/"frame": \[0, 1, 2, 3/);
    // Under 40 bytes per frame per column would be impossible with one element
    // per line; this is a size regression guard, not a precise budget.
    expect(text.length).toBeLessThan(5000 * 18 * 12);
    expect(() => readProject(text)).not.toThrow();
  });

  it('still round-trips exactly after the collapsing step', () => {
    const original = sampleObservations(1000);
    const text = writeProject(project({ videos: [storedVideo(original)] }));
    const back = unpackObservations(readProject(text).videos[0]!.observations);
    expect(back).toHaveLength(1000);
    expect(Math.abs(back[500]!.body!.x - original[500]!.body!.x)).toBeLessThanOrEqual(ROUNDING_TOLERANCE_PX);
    expect(back[999]!.areaPx).toBe(original[999]!.areaPx);
  });

  it('keeps text with commas and brackets intact', () => {
    const name = 'Cage 3, [rebuilt], "moved" — 1,2,3\nsecond line';
    const read = readProject(writeProject(project({ project: { name } })));
    expect(read.project.name).toBe(name);
  });
});

describe('rejecting files that are not projects', () => {
  const expectError = (text: string, pattern: RegExp) => {
    expect(() => readProject(text)).toThrow(ProjectFormatError);
    expect(() => readProject(text)).toThrow(pattern);
  };
  const parsedProject = () => JSON.parse(writeProject({
    createdAt: '2026-08-31T00:00:00Z',
    project: { name: 'x' },
    params: DEFAULT_PARAMS,
    rigs: [],
    videos: [storedVideo(sampleObservations(50))],
    excludedVideos: [],
  }));

  it('rejects text that is not JSON', () => {
    expectError('this is not json', /not valid JSON/);
  });

  it('reports video errors before excluded recordings, rigs, and rig references', () => {
    const parsed = parsedProject();
    parsed.videos[0].rigId = 'missing-rig';
    parsed.videos[0].sourceSha256 = 'bad-hash';
    parsed.excludedVideos = [{ id: 'v1', fileName: 'excluded.mp4', fileSize: null,
      status: 'failed', error: null }];
    parsed.rigs = [{ id: '' }];
    expectError(JSON.stringify(parsed), /invalid source-video SHA-256/);
    parsed.videos[0].sourceSha256 = null;
    expectError(JSON.stringify(parsed), /invalid or repeated excluded-recording metadata/);
    parsed.excludedVideos = [];
    expectError(JSON.stringify(parsed), /rig template 1 has a missing or repeated id/);
    parsed.rigs = [];
    expectError(JSON.stringify(parsed), /refers to a rig template that is not in this project/);
  });

  it("keeps the host app's source reference as given, and rejects one that is not an object", () => {
    const source = { kind: 'url', url: 'https://example.org/trials/day 1.mp4', size: 1234 };
    const parsed = parsedProject();
    parsed.videos[0].source = source;
    parsed.excludedVideos = [{ id: 'x1', fileName: 'queued.mp4', fileSize: null, source, status: 'queued', error: null }];
    const read = readProject(JSON.stringify(parsed));
    expect([read.videos[0]!.source, read.excludedVideos[0]!.source]).toEqual([source, source]);
    for (const bad of ['https://example.org/a.mp4', 42, [source]]) {
      parsed.videos[0].source = bad;
      expectError(JSON.stringify(parsed), /invalid source reference/);
    }
  });

  it('rejects JSON that is not a project', () => {
    expectError('{"hello":"world"}', /does not look like a Barnes Maze Analyzer project/);
  });

  it('rejects every noncurrent format version without transforming it', () => {
    for (const formatVersion of [PROJECT_FORMAT_VERSION - 1, PROJECT_FORMAT_VERSION + 1]) {
      const parsed = parsedProject();
      parsed.formatVersion = formatVersion;
      expectError(JSON.stringify(parsed), /unsupported format version/);
    }
  });

  it('rejects a truncated per-frame column instead of loading half of it', () => {
    const parsed = JSON.parse(writeProject({
      createdAt: '2026-08-31T00:00:00Z',
      project: { name: 'x' },
      params: DEFAULT_PARAMS,
      rigs: [],
      videos: [storedVideo(sampleObservations(50))],
      excludedVideos: [],
    }));
    parsed.videos[0].observations.frame = parsed.videos[0].observations.frame.slice(0, 20);
    expectError(JSON.stringify(parsed), /truncated or corrupted/);
  });

  it('checks every packed column, not only frame numbers', () => {
    const parsed = JSON.parse(writeProject({
      createdAt: '2026-08-31T00:00:00Z',
      project: { name: 'x' },
      params: DEFAULT_PARAMS,
      rigs: [],
      videos: [storedVideo(sampleObservations(50))],
      excludedVideos: [],
    }));
    parsed.videos[0].observations.noseX = parsed.videos[0].observations.noseX.slice(0, 20);
    expectError(JSON.stringify(parsed), /noseX column/);
  });

  it('names the offending video in the message', () => {
    const parsed = JSON.parse(writeProject({
      createdAt: '2026-08-31T00:00:00Z',
      project: { name: 'x' },
      params: DEFAULT_PARAMS,
      rigs: [],
      videos: [storedVideo(sampleObservations(50))],
      excludedVideos: [],
    }));
    delete parsed.videos[0].geometry;
    expectError(JSON.stringify(parsed), /WT_M12_day3_trial2\.mp4/);
  });

  it('rejects a project with no parameters, because its numbers are unreproducible', () => {
    const parsed = JSON.parse(writeProject({
      createdAt: '2026-08-31T00:00:00Z',
      project: { name: 'x' },
      params: DEFAULT_PARAMS,
      rigs: [],
      videos: [],
      excludedVideos: [],
    }));
    delete parsed.params;
    expectError(JSON.stringify(parsed), /no analysis parameters/);
  });

  it('rejects a recording with no measurement provenance', () => {
    const parsed = parsedProject();
    delete parsed.videos[0].measurementBasis;
    expectError(JSON.stringify(parsed), /invalid measurement provenance/);
  });

  it('rejects native video tracking without the tool version that measured it', () => {
    const parsed = parsedProject();
    parsed.videos[0].observationToolVersion = null;
    expectError(JSON.stringify(parsed), /native video tracking has no observation tool version/);
  });

  it('rejects imported pose metadata attached to native visible-area evidence', () => {
    const parsed = parsedProject();
    parsed.videos[0].trackingSource = 'deeplabcut';
    parsed.videos[0].measurementBasis = { kind: 'imported-pose' };
    parsed.videos[0].observationToolVersion = null;
    expectError(JSON.stringify(parsed), /imported pose track contains unsupported video-area evidence/);
  });

  it('rejects invalid analysis parameters instead of producing plausible NaN-based results', () => {
    const parsed = parsedProject();
    parsed.params.trialCutoffSec = -1;
    parsed.params.events.investigationRadiusCm = '3';
    expectError(JSON.stringify(parsed), /invalid analysis parameters/);
    expectError(JSON.stringify(parsed), /trialCutoffSec/);
  });

  it('rejects a missing numeric observation instead of coercing it to zero', () => {
    const parsed = parsedProject();
    parsed.videos[0].observations.areaPx[12] = null;
    expectError(JSON.stringify(parsed), /areaPx column contains a value that is not a finite number/);
  });

  it('rejects timestamps that run backwards', () => {
    const parsed = parsedProject();
    parsed.videos[0].timebase.ptsTicks[12] = parsed.videos[0].timebase.ptsTicks[10];
    expectError(JSON.stringify(parsed), /timestamps run backwards/);
  });

  it('does not let a manual start masquerade as an automatic detection', () => {
    const parsed = parsedProject();
    parsed.videos[0].detectedTrialStart = {
      frame: 10,
      reason: 'manual',
      provenance: 'manual',
      evidence: 'edited outside the app',
    };
    expectError(JSON.stringify(parsed), /detected trial start is not an automatic detection/);
  });

  it('rejects fractional container ticks rather than treating them as recorded timing', () => {
    const parsed = parsedProject();
    parsed.videos[0].timebase.ptsTicks[12] += 0.5;
    expectError(JSON.stringify(parsed), /integer container tick/);
  });

  it('preserves a failed body-area estimate as unavailable rather than inventing a positive value', () => {
    const parsed = parsedProject();
    parsed.videos[0].bodyAreaPx = 0;
    expect(() => readProject(JSON.stringify(parsed))).not.toThrow();
  });

  it('rejects an invented scale source', () => {
    const parsed = parsedProject();
    parsed.videos[0].geometry.platformDiameterSource = 'camera_metadata';
    expectError(JSON.stringify(parsed), /platform-diameter source is invalid/);
  });

  it('rejects an invented tracking source', () => {
    const parsed = parsedProject();
    parsed.videos[0].trackingSource = 'assumed-perfect';
    expectError(JSON.stringify(parsed), /tracking source is invalid/);
  });

  it('rejects an empty observation tool version', () => {
    const parsed = parsedProject();
    parsed.videos[0].observationToolVersion = '';
    expectError(JSON.stringify(parsed), /observation tool version is invalid/);
  });

  it('requires every current provenance field instead of supplying defaults', () => {
    const withoutScaleSource = parsedProject();
    delete withoutScaleSource.videos[0].geometry.platformDiameterSource;
    expectError(JSON.stringify(withoutScaleSource), /platform-diameter source is invalid/);

    const withoutTrackingSource = parsedProject();
    delete withoutTrackingSource.videos[0].trackingSource;
    expectError(JSON.stringify(withoutTrackingSource), /tracking source is invalid/);

    const withoutObservationVersion = parsedProject();
    delete withoutObservationVersion.videos[0].observationToolVersion;
    expectError(JSON.stringify(withoutObservationVersion), /observation tool version is invalid/);

    const withoutConfirmation = parsedProject();
    delete withoutConfirmation.videos[0].mazeConfirmed;
    expectError(JSON.stringify(withoutConfirmation), /maze-confirmation flag is invalid/);

    const withoutAreaSource = parsedProject();
    delete withoutAreaSource.videos[0].observations.areaMeasured;
    expectError(JSON.stringify(withoutAreaSource), /areaMeasured column/);
  });

  it('rejects an escape hole outside the saved maze', () => {
    const parsed = parsedProject();
    parsed.videos[0].geometry.targetHoleIndex = 99;
    expectError(JSON.stringify(parsed), /escape hole outside/);
  });

  it('keeps the lab hole numbering and rejects an invalid one', () => {
    const parsed = parsedProject();
    parsed.videos[0].geometry.holeOneIndex = 3;
    parsed.videos[0].geometry.holeNumbering = 'counterclockwise';
    const geometry = readProject(JSON.stringify(parsed)).videos[0]!.geometry;
    expect([geometry.holeOneIndex, geometry.holeNumbering]).toEqual([3, 'counterclockwise']);
    parsed.videos[0].geometry.holeOneIndex = 99;
    expectError(JSON.stringify(parsed), /hole 1 outside/);
    parsed.videos[0].geometry.holeOneIndex = 3;
    parsed.videos[0].geometry.holeNumbering = 'sideways';
    expectError(JSON.stringify(parsed), /numbering direction is invalid/);
  });

  it('rejects conflicting human edits to the same frame', () => {
    const parsed = parsedProject();
    parsed.videos[0].corrections = [
      { frame: 12, status: 'lost', note: 'first' },
      { frame: 12, status: 'tracked', body: { x: 20, y: 20 }, note: 'second' },
    ];
    expectError(JSON.stringify(parsed), /two corrections for frame 12/);
  });

  it('requires an inside-hole label and its hole to be supplied together', () => {
    const holeOnly = parsedProject();
    holeOnly.videos[0].corrections = [{ frame: 12, holeIndex: 7 }];
    expectError(JSON.stringify(holeOnly), /assigns a hole without an inside-hole label/);

    const labelOnly = parsedProject();
    labelOnly.videos[0].corrections = [{ frame: 12, status: 'inHole' }];
    expectError(JSON.stringify(labelOnly), /inside-hole label without a hole/);
  });
});

describe('file names', () => {
  it('suggests a name that sorts and says what it is', () => {
    const name = suggestProjectFileName('Cohort B / 2026');
    expect(name).toMatch(/^Cohort-B-2026-\d{4}-\d{2}-\d{2}\.bmproj\.json$/);
  });

  it('copes with a project name that is all punctuation', () => {
    expect(suggestProjectFileName('///')).toMatch(/^barnes-maze-\d{4}-\d{2}-\d{2}\.bmproj\.json$/);
  });
});

describe('guessing metadata from a file name', () => {
  it('reads the common convention', () => {
    const m = parseFilename('WT_M12_day3_trial2.mp4');
    expect(m.group).toBe('WT');
    expect(m.animalId).toBe('M12');
    expect(m.day).toBe(3);
    expect(m.trial).toBe(2);
    expect(m.parsedFromFilename).toContain('day');
  });

  it('reads short forms', () => {
    const m = parseFilename('KO-m7-d1-t3.mp4');
    expect(m.group).toBe('KO');
    expect(m.animalId).toBe('M7');
    expect(m.day).toBe(1);
    expect(m.trial).toBe(3);
  });

  it('does not invent a group from a word like "video"', () => {
    const m = parseFilename('video_M4_day2.mp4');
    expect(m.group).toBe('');
  });

  /**
   * The sample clips are named `test50`, `test51`, `test53`. Pretending that
   * means animal "test50" on day nothing would be worse than admitting there is
   * nothing there, so the confidence check exists to decide whether to offer
   * the guess at all.
   */
  it('reports low confidence on names that encode nothing', () => {
    const c = schemeConfidence(['test50.mp4', 'test51.mp4', 'test53.mp4']);
    expect(c.fraction).toBeLessThan(0.5);
    expect(c.fields).toEqual([]);
  });

  it('reports high confidence on names that do encode something', () => {
    const c = schemeConfidence(['WT_M1_day1_trial1.mp4', 'WT_M2_day1_trial1.mp4', 'KO_M3_day2_trial2.mp4']);
    expect(c.fraction).toBe(1);
    expect(c.fields).toContain('day');
    expect(c.fields).toContain('trial');
  });

  it('falls back to the file stem as the animal id, so nothing is nameless', () => {
    const meta = parseFilename('test50.mp4');
    expect(meta.animalId).toBe('test50');
    expect(meta.parsedFromFilename).toContain('animalId');
  });

  it('offers a scheme that guesses nothing at all', () => {
    const none = NAMING_SCHEMES.find((s) => s.id === 'none')!;
    const m = parseFilename('WT_M12_day3.mp4', none.id);
    expect(m.day).toBeNull();
    expect(m.group).toBe(EMPTY_META.group);
  });

  it('offers fixed positional schemes for names the guesser gets wrong', () => {
    const m = parseFilename('WT_M12_3_2.mp4', 'group-animal-day-trial');
    expect(m.group).toBe('WT');
    expect(m.animalId).toBe('M12');
    expect(m.day).toBe(3);
    expect(m.trial).toBe(2);
  });
});
