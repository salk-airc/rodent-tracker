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

The engine has three parts. A paradigm (one behavior test) is the configuration that joins
them.

1. **Arena** (`src/arena/`): where the apparatus is in the image and how pixels map to
   centimeters. A finder proposes it from the empty-arena background and the apparatus's
   real size (`findRoundArena`, `findBoxArena`, `findBarnesArena`), with a confidence; a
   person confirms it, or places it by hand from the layout's landmarks.
2. **Tracking** (`src/tracking/`, `src/detect/`): where the animal is each frame. Found in
   the video (`trackInArena`), or taken from another tracker such as SLEAP, DeepLabCut or a
   camera that tracks on board (`trackFromPositions`). Both give the same `ArenaTrack`.
3. **Scoring** (`src/paradigms/`): the test's measures from the arena and the track. Every
   paradigm also returns them in one common form (`report`): each metric's id, label, unit,
   one-line definition, value, and whether the value is complete, so an app can show and
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

Scoring positions from another tracker skips the video:

```ts
const track = trackFromPositions(sleapPositions, arena, { sourceId: 'sleap' }); // image px, or { space: 'world' }
const result = openField.score(track, { arena });
```

## Origins

- [salk-airc/barnes-maze](https://github.com/salk-airc/barnes-maze) by Simon Dräger: the
  base of this repo (decoding, frame sources, detection, resolve, measures, project format,
  export). Imported at commit `3fef1c5`.
- The AIRC Barnes Maze Review app: its tracker is the `silhouette-taper-v1`
  detector (pixel-budget detection, full-resolution nose taper, orientation continuity,
  a written reason for every doubtful frame).

## Layout

| Path | What it is |
|---|---|
| `src/video/` | Frame sources: WebCodecs in the browser, ffmpeg in Node |
| `src/image/` | Image operations and the empty-arena background |
| `src/detect/` | Detectors, their default settings and size scaling |
| `src/tracking/detectFrames.ts` | The one pixel pass every paradigm shares |
| `src/tracking/arenaTrack.ts` | A track in world cm with zones, from the video or from imported positions |
| `src/arena/` | Shapes, calibration, zones, zone measures and arm-maze layouts |
| `src/arena/find/` | Arena finders: round arenas, boxes (with perspective), the bright-disc fit they share |
| `src/io/` | CSV and XLSX writers |
| `src/paradigm.ts` | The `Paradigm` interface apps program against, and the common report |
| `src/paradigms/barnes/` | Barnes maze: platform and hole fit, events, measures and search strategy |
| `src/paradigms/open-field/` | Open field: distance, speed, center and wall time |
| `src/paradigms/elevated-plus/` | Elevated plus maze: open- against closed-arm time and entries |
| `src/paradigms/y-maze/` | Y-maze: spontaneous alternation from the arm-entry order |
| `src/paradigms/fear-conditioning/` | Fear conditioning: freezing from frame-to-frame motion |
| `src/tracking/motion.ts` | Motion per frame and freezing bouts, no tracking needed |

Nothing outside `src/paradigms/` imports from it.

## Paradigms

| Paradigm | Id | Arena finder | Status |
|---|---|---|---|
| Barnes maze | `barnes-maze` | `findBarnesArena` | Scoring from Simon's app; its project files, review and exports are in tracking-platform |
| Open field | `open-field` | `findBoxArena`, or `findRoundArena` for a round one | Checked on synthetic video; needs real IVSS video |
| Elevated plus maze | `elevated-plus-maze` | Landmarks, placed by hand | Checked on synthetic video; no head dips yet |
| Y-maze spontaneous alternation | `y-maze` | Landmarks, placed by hand | Checked on synthetic video |
| Fear conditioning | `fear-conditioning` | None needed; an optional mask | Checked on synthetic video; the freezing threshold is set per rig |

Open field, plus maze and Y-maze are `ArenaParadigm`s: besides `analyze` (track the video,
then score) they have `score(track, config)`, so they score imported tracks too.

A new paradigm is an arena template, its metric definitions, a `score` and a `report`; see
`src/paradigms/open-field/` for the smallest complete one.

Arm mazes come from one layout function, `armMazeLayout` in `src/arena/armMaze.ts`: evenly
spaced arms of one width around a hub, with `elevatedPlusMaze()` and `yMaze()` on top (an
8-arm radial maze is the same call). Each layout lists landmarks (arm-end corners and tips)
in world cm, so an app can calibrate by having someone click them on the first frame:

```ts
const layout = yMaze({ armLengthCm: 35, armWidthCm: 5 });
const calibration = homographyFromPoints(clicks.map((image, i) => ({ image, world: layout.landmarks[i].world })));
const result = await yMazeAlternation.analyze(source, { arena: { ...layout, calibration } });
result.summary.sequence;       // ['A', 'B', 'C', 'A', …]
result.summary.alternationPct; // alternations / (entries − 2) × 100
```

Fear conditioning scores freezing from motion alone, following ezTrack's freeze analysis
(Pennington et al. 2019): each frame is blurred, the pixels that changed by more than a
cutoff since the previous frame are counted, and freezing is that count staying below a
threshold for at least 1 s. The cutoff is twice the 99.99th percentile of frame-to-frame
change on animal-free frames when given (`calibration`), or estimated robustly from the
whole recording. No tracking is needed, so a side-on camera works.

Entries in both mazes are the smoothed body center crossing into an arm and staying 0.2 s.
`entryMarginCm` moves the arm line further out, which comes closer to an all-four-paws rule.

## Detectors

A `Detector` (`src/detect/types.ts`) turns each decoded frame into a body, nose and tail
position. Everything downstream (arena, events, measures, review) only sees its output, so
detectors can be swapped and compared on the same video.

| Detector | From | Default |
|---|---|---|
| `dark-blob-v1` | Simon's Barnes maze app | yes |
| `silhouette-taper-v1` | The AIRC Barnes Maze Review app | |

See [docs/BENCHMARK.md](docs/BENCHMARK.md) for how they compare.

Detector sizes (noise floor, erosion, search window, area caps) were tuned on the sample
clips at about 4.7 px/cm. For a camera that images the animal bigger or smaller, pass
`sizeScale` (`sizeScaleFor(pxPerCm)` from `src/detect/scale.ts`) and they follow:
lengths by the scale, areas by its square. The Barnes pipeline leaves this off by default
(`scaleSizesToCalibration`) so its regression outputs stay fixed.

## Arenas and zones

`src/arena/` describes any arena, not just the Barnes platform:

- **Shapes**: circle, rectangle, polygon (concave is fine, e.g. a plus maze) and annulus.
- **Calibration**: image px to world cm, from two points a known distance apart, or a
  least-squares homography from four or more points for a camera at an angle.
- **Zones**: named shapes in world cm, so a template such as a 40 × 40 cm open field with
  its center square is written once and fitted to each camera by calibration alone.
- **Zone measures**: time in zone, entries, latency to first entry and distance, with the
  conventions for tracking gaps and line flicker written down in `zoneMeasures.ts`.

- **Finders** (`src/arena/find/`): an `ArenaFit` is the placed arena, a confidence from 0
  to 1, the image points it rests on, and warnings. Below `CONFIDENT_FIT` (0.6), have
  someone check it. `findRoundArena` needs only the diameter; `findBoxArena` takes the
  floor's four corners and the box's width and height, so a camera at an angle still measures
  true centimeters.

Image coordinates follow one convention throughout: pixel (x, y) is the point (x, y), so a
pixel covers half a pixel either side of it. Detections, finders and arena masks all agree.

The Barnes maze keeps its own fitted geometry (`MazeGeometry`) for its analysis.
`findBarnesArena` finds it (Simon's platform, hole and ring fit) and returns it alongside the
same maze as an engine arena (platform boundary, a zone per hole).

## Use it from another repo

The package exports its TypeScript source, so a bundler (Vite), `tsx` or Vitest compiles it
with the app. Install it from git, pinned to a commit:

```bash
pnpm add "rodent-tracker@git+https://github.com/salk-airc/rodent-tracker.git#<commit>"
```

```ts
import { openFieldZones } from 'rodent-tracker/arena/arena';
import { barnesMaze } from 'rodent-tracker/paradigms/barnes/index';
import { makeGeometry } from 'rodent-tracker/testing/synthetic'; // test helpers
```

Every file under `src/` is importable by its path. Vitest needs
`server: { deps: { inline: ['rodent-tracker'] } }` so it compiles the package instead of
handing `.ts` files to Node.

## Develop

```bash
pnpm install
pnpm test        # unit tests; the sample-clip tests skip until you run `pnpm samples`
pnpm typecheck
pnpm samples     # download the 3 sample clips into data/barnes-maze/
pnpm regress     # re-run the 3 sample clips and compare the scoring with outputs/barnes/
pnpm benchmark   # compare detectors on the sample clips (docs/BENCHMARK.md)
```

The sample clips are the ones published with the Salk AIRC
[RSE take-home](https://github.com/salk-airc/rse-takehome-2026). They aren't kept in this repo:
`pnpm samples` downloads them from a pinned commit and checks their SHA-256 (see
[`data/barnes-maze/README.md`](data/barnes-maze/README.md)). `pnpm regress` and
`pnpm benchmark` download them too if they're missing.
