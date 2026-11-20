# Sample recordings

Three sample recordings, listed in
[`src/paradigms/barnes/samples.ts`](../../src/paradigms/barnes/samples.ts). The
golden tests, `pnpm regress` and `pnpm benchmark` read them from here, and
[tracking-platform](https://github.com/salk-airc/tracking-platform) reads them
from the installed package for its export check. The committed results in
[`outputs/barnes/`](../../outputs/barnes/) were generated from these exact
files, so don't re-encode them:

| File | SHA-256 |
|---|---|
| `test50.mp4` | `654e98559f5a81b964316487a457b206915a3ad9b084c7944c1afda3186fff87` |
| `test51.mp4` | `6e62674589c8915fa6b6cf1fc78ba8e9a0b29fec6086817d6ad2dd14493a6743` |
| `test53.mp4` | `351e85627241debbe7b2624d84e1c7ce97086db04fed215305019cb358d4d571` |

| File | Frames | Frame rate | Notes |
|---|---|---|---|
| `test50.mp4` | 5,539 | 30 fps nominal | Longer than the default 180 s cutoff. The provisional detector output has a censored total latency. |
| `test51.mp4` | 741 | **15000/1001 fps** | The trial-start detector finds a central-cylinder transition. |
| `test53.mp4` | 905 | 30 fps nominal | The provisional detector output includes a terminal low-area event. |

All three are 640×480 H.264, `yuv420p`, no audio, from a grayscale overhead
camera. None is constant frame rate in practice: the re-encode left frames
sharing a presentation timestamp with their neighbor and intervals at twice and
at a fraction of the nominal one, so durations come from container timestamps
([`src/time.ts`](../../src/time.ts)), never from frame count over frame rate.
