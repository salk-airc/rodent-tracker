# rodent-tracker

An engine for tracking a rodent in overhead behavior video, in the browser or in Node:
decode, detect the animal, fit the arena, find events in zones, compute measures, and keep
every value's provenance (automatic, imported or corrected by a person) for review.

Status: early. The code is imported from two Barnes maze apps and is being generalized so
that each behavior test (Barnes, open field, Y-maze, elevated plus maze, water maze, novel
object…) is a small plugin on top of one engine.

## Origins

- [salk-airc/barnes-maze](https://github.com/salk-airc/barnes-maze) by Simon Dräger: the
  base of this repo (decoding, frame sources, detection, resolve, measures, project format,
  export). Imported at commit `3fef1c5`.
- The Barnes Maze Review app by Andrew Wilson: its tracker is the `silhouette-taper-v1`
  detector (pixel-budget detection, full-resolution nose taper, orientation continuity,
  a written reason for every doubtful frame).

## Layout

| Path | What it is |
|---|---|
| `src/video/` | Frame sources: WebCodecs in the browser, ffmpeg in Node |
| `src/image/` | Image operations and the empty-arena background |
| `src/detect/` | Detectors, their default settings and size scaling |
| `src/tracking/detectFrames.ts` | The one pixel pass every paradigm shares |
| `src/tracking/arenaTrack.ts` | Background, detection, world cm and smoothing for zone-based paradigms |
| `src/arena/` | Shapes, calibration, zones, zone measures and arm-maze layouts |
| `src/io/` | CSV and XLSX writers |
| `src/paradigm.ts` | The `Paradigm` interface apps program against |
| `src/paradigms/barnes/` | Barnes maze: geometry fit, holes, events, strategy, project format, review and exports |
| `src/paradigms/open-field/` | Open field: distance, speed, center and wall time |
| `src/paradigms/elevated-plus/` | Elevated plus maze: open- against closed-arm time and entries |
| `src/paradigms/y-maze/` | Y-maze: spontaneous alternation from the arm-entry order |

Nothing outside `src/paradigms/` imports from it.

## Paradigms

| Paradigm | Id | Status |
|---|---|---|
| Barnes maze | `barnes-maze` | Full: Simon's analysis, project files, review, exports |
| Open field | `open-field` | Measures only, checked on synthetic video; needs real IVSS video |
| Elevated plus maze | `elevated-plus-maze` | Measures only, checked on synthetic video; no head dips yet |
| Y-maze spontaneous alternation | `y-maze` | Measures only, checked on synthetic video |

```ts
import { openField } from './src/paradigms/open-field';
import { openFieldZones } from './src/arena/arena';
import { scaleFromTwoPoints } from './src/arena/calibration';

const arena = { ...openFieldZones(40, 40), calibration: scaleFromTwoPoints(topLeftPx, topRightPx, 40) };
const result = await openField.analyze(source, { arena });
result.summary; // distance, speed, center time, entries, latency, time near walls
```

A new paradigm is an arena template plus its measures; see `src/paradigms/open-field/` for
the smallest complete one.

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

Entries in both mazes are the smoothed body center crossing into an arm and staying 0.2 s.
`entryMarginCm` moves the arm line further out, which comes closer to an all-four-paws rule.

## Detectors

A `Detector` (`src/detect/types.ts`) turns each decoded frame into a body, nose and tail
position. Everything downstream (arena, events, measures, review) only sees its output, so
detectors can be swapped and compared on the same video.

| Detector | From | Default |
|---|---|---|
| `dark-blob-v1` | Simon's Barnes maze app | yes |
| `silhouette-taper-v1` | Andrew's Barnes Maze Review | |

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

The Barnes maze keeps its own fitted geometry (`MazeGeometry`) for its analysis, and
`barnesArena()` expresses it as an arena (platform boundary, a zone per hole) for generic tools.

## Develop

```bash
pnpm install
pnpm test        # unit tests
pnpm typecheck
pnpm regress     # re-run the 3 sample clips and compare with outputs/
pnpm benchmark   # compare detectors on the sample clips (docs/BENCHMARK.md)
```

The sample clips in `data/barnes-maze/` come from the Salk AIRC RSE take-home exercise.
