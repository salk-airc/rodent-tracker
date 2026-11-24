# rodent-tracker

An engine for tracking a rodent in overhead behavior video, in the browser or in Node:
decode, detect the animal, fit the arena, find events in zones, compute measures, and keep
every value's provenance (automatic, imported or corrected by a person).

Apps built on it (upload, calibration clicks, review screens, project files, exports) live in
[salk-airc/tracking-platform](https://github.com/salk-airc/tracking-platform). This repo has
no UI and no file formats of its own beyond plain CSV and XLSX writers.

Status: early. The code is imported from two Barnes maze apps and is being generalized so
that each behavior test (Barnes, open field, Y-maze, elevated plus maze, water maze, novel
object…) is a small plugin on top of one engine.

## How it fits together

A paradigm (one behavior test) is the configuration that joins the engine's three parts:

1. Arena (`src/arena/`): where the apparatus is in the image and how pixels map to
   centimeters. A finder proposes it from the empty-arena background and the apparatus's
   real size, with a confidence; a person confirms it, or places it by hand from the
   layout's landmarks.
2. Tracking (`src/tracking/`, `src/detect/`): where the animal is each frame. Found in the
   video (`trackInArena`), or taken from another tracker such as SLEAP, DeepLabCut or a
   camera that tracks on board (`trackFromPositions`). Both give the same `ArenaTrack`.
3. Scoring (`src/paradigms/`): the test's measures from the arena and the track. Every
   paradigm also returns them in one common form (`report`): each metric's id, label, unit,
   one-line definition, value, and whether the value is complete. An app can show and
   export any test without knowing it.

```ts
import { CONFIDENT_FIT, findBoxArena } from 'rodent-tracker/arena/find/index';
import { buildBackground } from 'rodent-tracker/image/background';
import { openField } from 'rodent-tracker/paradigms/open-field/index';
import { reportRows } from 'rodent-tracker/paradigm';

const background = await buildBackground(source);
const fit = findBoxArena(background.image, { widthCm: 40, heightCm: 40 }); // 1. arena
const arena = fit.arena && fit.confidence >= CONFIDENT_FIT ? fit.arena : await askSomeoneToPlaceIt(fit);
const result = await openField.analyze(source, { arena }); // 2. track, 3. score
reportRows(openField, openField.report(result)); // [{ id, label, unit, definition, value, complete }, …]
```

Any arena paradigm also scores per time bin (per minute, say), and scores tracks from
another tracker without the video:

```ts
const track = await trackInArena(source, arena);
binReports(openField, track, { arena }, 60); // [{ startS: 0, endS: 60, report }, { startS: 60, … }, …]

const imported = trackFromPositions(sleapPositions, arena, { sourceId: 'sleap' }); // image px, or { space: 'world' }
openField.score(imported, { arena });
```

An entry belongs to the bin it happens in. An animal sitting in a zone across a bin edge
isn't counted as entering again, and latencies are from the start of the bin
(`binReports` in `src/paradigm.ts`).

## Paradigms

| Paradigm | Id | Arena finder | Status |
|---|---|---|---|
| Barnes maze | `barnes-maze` | `findBarnesArena` | Scoring from Simon's app; its project files, review and exports are in tracking-platform |
| Open field | `open-field` | `findBoxArena`, or `findRoundArena` for a round one | Checked on synthetic video; needs real IVSS video |
| Elevated plus maze | `elevated-plus-maze` | Landmarks, placed by hand | Checked on synthetic video; no head dips yet |
| Y-maze spontaneous alternation | `y-maze` | Landmarks, placed by hand | Checked on synthetic video |
| Fear conditioning | `fear-conditioning` | None needed; an optional mask | Checked on synthetic video; the freezing threshold is set per rig |

Open field, plus maze and Y-maze are `ArenaParadigm`s, with `score(track, config)` besides
`analyze`. A new paradigm is an arena template, its metric definitions, a `score` and a
`report`; `src/paradigms/open-field/` is the smallest complete one.

Arm mazes come from `armMazeLayout` in `src/arena/armMaze.ts`, with `elevatedPlusMaze()` and
`yMaze()` on top (an 8-arm radial maze is the same call). Each layout lists landmarks
(arm-end corners and tips) in world cm. An app can calibrate from clicks on the first frame:

```ts
const layout = yMaze({ armLengthCm: 35, armWidthCm: 5 });
const calibration = homographyFromPoints(clicks.map((image, i) => ({ image, world: layout.landmarks[i].world })));
const result = await yMazeAlternation.analyze(source, { arena: { ...layout, calibration } });
result.summary.sequence;       // ['A', 'B', 'C', 'A', …]
result.summary.alternationPct; // alternations / (entries − 2) × 100
```

Entries in both mazes are the smoothed body center crossing into an arm and staying 0.2 s.
`entryMarginCm` moves the arm line further out, which comes closer to an all-four-paws rule.

Fear conditioning scores freezing from frame-to-frame motion alone, following ezTrack's
freeze analysis (Pennington et al. 2019). A side-on camera works. The method and the
motion cutoff's calibration are in `src/tracking/motion.ts`.

## Detectors

A `Detector` (`src/detect/types.ts`) turns each decoded frame into a body, nose and tail
position. Everything downstream only sees its output. Detectors can be swapped and
compared on the same video.

| Detector | From | Default |
|---|---|---|
| `dark-blob-v1` | Simon's Barnes maze app | yes |
| `silhouette-taper-v1` | The AIRC Barnes Maze Review app | |

[docs/BENCHMARK.md](docs/BENCHMARK.md) compares them on the sample clips.

Detectors look for an animal darker than the floor. For an albino mouse on a dark floor, pass
`animalContrast: 'lighter'` to any paradigm (including Barnes) or `'either'` for mixed/mottled
contrast; the frames are transformed so the animal reads as darker (`src/image/contrast.ts`).
Finders take `floor: 'dark'` for a dark floor in a lit room.

Detector sizes were tuned on adult mice in the sample clips at about 4.7 px/cm. Camera scale
(`sizeScaleFor(pxPerCm)`) and rodent morphology (`AnimalProfile`: `MOUSE_PROFILE`, `RAT_PROFILE`,
`JUVENILE_MOUSE_PROFILE`, `SHORT_TAILED_PROFILE` in `src/detect/scale.ts`) scale independently.
The Barnes pipeline leaves camera scaling off by default (`scaleSizesToCalibration`) so its
regression outputs stay fixed.

## Arenas and zones

An arena (`src/arena/`) is a boundary shape (circle, rectangle, polygon or annulus), a
calibration from image px to world cm (two points a known distance apart, or a homography
from four or more for a camera at an angle) and named zones in world cm. A template such as
a 40 × 40 cm open field with its center square is written once and fitted to each camera by
calibration alone. Zone measures and their conventions for tracking gaps and line flicker
are in `src/arena/zoneMeasures.ts`.

A finder (`src/arena/find/`) returns an `ArenaFit`: the placed arena, a confidence from 0
to 1, the image points it rests on, and warnings. Below `CONFIDENT_FIT` (0.6), have someone
check it. `findRoundArena` needs only the diameter; `findBoxArena` matches the floor's four
corners to the box's width and height. A camera at an angle still measures true
centimeters. `findBarnesArena` returns the Barnes maze's own fitted geometry (`MazeGeometry`)
alongside the same maze as an engine arena (platform boundary, a zone per hole).

## Layout

| Path | What it is |
|---|---|
| `src/video/` | Frame sources: WebCodecs in the browser, ffmpeg in Node |
| `src/image/` | Image operations and the empty-arena background |
| `src/detect/` | Detectors, their default settings and size scaling |
| `src/tracking/` | The pixel pass every paradigm shares, arena tracks, motion and freezing |
| `src/arena/` | Shapes, calibration, zones, zone measures, arm-maze layouts and finders |
| `src/io/` | CSV, XLSX, and DeepLabCut/SLEAP pose CSV import/export |
| `src/paradigm.ts` | The `Paradigm` interface apps program against, and the common report |
| `src/paradigms/` | One folder per paradigm; nothing outside it imports from it |
| `tools/` | Sample download, regression and benchmark scripts |

## Use it from another repo

The package exports its TypeScript source. A bundler (Vite), `tsx` or Vitest compiles it
with the app. Install it from git, pinned to a commit:

```bash
pnpm add "rodent-tracker@git+https://github.com/salk-airc/rodent-tracker.git#<commit>"
```

```ts
import { openFieldZones } from 'rodent-tracker/arena/arena';
import { barnesMaze } from 'rodent-tracker/paradigms/barnes/index';
import { makeGeometry } from 'rodent-tracker/testing/synthetic'; // test helpers
```

Every file under `src/` is importable by its path, and `tests/helpers/` as
`rodent-tracker/testing/*`. Vitest needs `server: { deps: { inline: ['rodent-tracker'] } }`
so it compiles the package's `.ts` files itself.

## Develop

Needs Node 22 or later and pnpm. The sample-clip tests and tools also need `ffmpeg` and `ffprobe`
on the path.

```bash
pnpm install
pnpm test        # unit tests; the sample-clip tests skip until you run `pnpm samples`
pnpm typecheck
pnpm samples     # download the 3 sample clips into data/barnes-maze/
pnpm regress     # re-run the 3 sample clips and compare the scoring with outputs/barnes/
pnpm analyze     # re-run them and rewrite outputs/barnes/
pnpm benchmark   # compare detectors on the sample clips (--write updates docs/BENCHMARK.md)
```

The sample clips are the ones published with the Salk AIRC
[RSE take-home](https://github.com/salk-airc/rse-takehome-2026). `pnpm samples` downloads
them from a pinned commit and checks their SHA-256 (see
[`data/barnes-maze/README.md`](data/barnes-maze/README.md)); `pnpm regress`, `pnpm analyze`
and `pnpm benchmark` download them too if they're missing.

## Origins

- [salk-airc/barnes-maze](https://github.com/salk-airc/barnes-maze) by Simon Dräger: the
  base of this repo (decoding, frame sources, detection, resolve, measures, project format,
  export). Imported at commit `3fef1c5`.
- The AIRC Barnes Maze Review app: its tracker is the `silhouette-taper-v1` detector
  (pixel-budget detection, full-resolution nose taper, orientation continuity, a written
  reason for every doubtful frame).

## License

MIT, see [LICENSE](LICENSE).
