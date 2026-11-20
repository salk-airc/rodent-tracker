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
| `src/arena/` | Shapes, calibration, zones and zone measures |
| `src/io/` | CSV and XLSX writers |
| `src/paradigm.ts` | The `Paradigm` interface apps program against |
| `src/paradigms/barnes/` | Barnes maze: platform and hole fit, events, measures and search strategy |
| `src/paradigms/open-field/` | Open field: distance, speed, center and wall time |

Nothing outside `src/paradigms/` imports from it.

## Paradigms

| Paradigm | Id | Status |
|---|---|---|
| Barnes maze | `barnes-maze` | Scoring from Simon's app; its project files, review and exports are in tracking-platform |
| Open field | `open-field` | Measures only, checked on synthetic video; needs real IVSS video |

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
pnpm test        # unit tests
pnpm typecheck
pnpm regress     # re-run the 3 sample clips and compare the scoring with outputs/barnes/
pnpm benchmark   # compare detectors on the sample clips (docs/BENCHMARK.md)
```

The sample clips in `data/barnes-maze/` come from the Salk AIRC RSE take-home exercise.
