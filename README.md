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
- The Barnes Maze Review app by Andrew Wilson: nose refinement, orientation continuity and
  per-frame uncertainty reasons, being ported next.

## Develop

```bash
pnpm install
pnpm test        # unit tests
pnpm typecheck
pnpm regress     # re-run the 3 sample clips and compare with outputs/
```

The sample clips in `data/barnes-maze/` come from the Salk AIRC RSE take-home exercise.
