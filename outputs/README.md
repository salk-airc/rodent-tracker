# Generated outputs

Produced by `pnpm analyze` from the three clips in [`data/barnes-maze/`](../data/barnes-maze/).

> [!WARNING]
> Provisional regression artifacts only. Maze outlines, scale, and suggested escape holes are unconfirmed.
> Tables mark every row `provisional` and list the missing confirmations. Do not use them as scientific results.

| File | What it is |
|---|---|
| `review-report.html` | Printable review of all three clips, with qualifications, events, and settings. |
| `trial-overview.csv` | Concise per-trial measurements and review notes. |
| `trial-summary.csv` | Full per-trial measurements and provenance. |
| `events.csv` | Hole investigations and entries with evidence. |
| `quality-report.csv` | Tracking gaps and warnings. |
| `parameters.csv` | The settings these numbers came from. |
| `barnes-maze-results.xlsx` | Overview, trial details, events, quality, and parameters in one workbook. |
| `*-frames.csv` | Per-frame positions, one file per clip. |
| `sample-project.bmproj.json` | Reloadable project with saved tracking. |

## Provisional pipeline output

| Clip | Status | Trial start | Suggested target | Primary latency | Total latency | Errors | Measured path | Strategy | Coverage |
|---|---|---|---|---|---|---|---|---|---|
| `test50.mp4` | **provisional** | 5.00 s (animalAppeared) | 5 | 1.40 s | ≥ 180.00 s *(censored)* | 0 / 19 | 1284 cm | spatial | 100.0% |
| `test51.mp4` | **provisional** | 5.00 s (cylinderLift) | 19 | 30.90 s | ≥ 44.31 s *(censored)* | 4 / 4 | 184 cm | unclassified | 100.0% |
| `test53.mp4` | **provisional** | 5.00 s (animalAppeared) | 2 | 4.07 s | 23.33 s | 1 / 3 | 101 cm | unclassified | 100.0% |

All rows are provisional. Errors are primary / total; ≥ marks incomplete tracking and n/a marks no usable evidence. Censored latency is a cutoff lower bound, not a measurement.
Hole numbers are the one-based labels shown clockwise in the application.

## What the tool was unsure about

**`test50.mp4`**

- No target entry was detected. Total latency is censored at 180.00 s and excluded from means.

**`test51.mp4`**

- No target entry was detected. Total latency is censored at 44.31 s and excluded from means.

**`test53.mp4`**

- No detector warnings.
