# diff-speed-20261127

[![make.fun](https://make.fun/c/diff-speed-01-run-20261126/badge)](https://make.fun/c/diff-speed-01-run-20261126)

A faster drop-in for makefun-diff 1.0.0, for the [make.fun competition "Diff two texts faster, 27 November 2026"](https://make.fun/c/diff-speed-01-run-20261126) ($100, 10 places).

`solve.js` exports `run(input)`, returning makefun-diff 1.0.0's patch for `{ old, new }` exactly — same greedy Myers search, same tie-break (a deletion wins when it reaches as far as an insertion), same patch format — but much faster:

- every line is interned to one integer id, so the search compares integers, not strings;
- the search runs on typed-array V rows (one snapshot per depth, kept only for backtracking) instead of allocating a path object per diagonal step;
- snapshots are `Uint16Array` when the texts fit (under 65,535 lines) and `Int32Array` otherwise;
- the exact edit script is rebuilt by walking those snapshots backwards with the same choice rule.

Measured on the kit's practice set (4 cases, 21k–31k lines each, edit distance ~3,500–4,000): answers identical to the reference on all 4 cases, and **~3.7–4.3x faster** than the house baseline per case (median over repeated runs, same machine, `--no-incremental-marking`).

`main.ts` is the kit's own driver: it reads `/input/cases.json`, answers each case alone with `run()`, and writes `/output/answers.json`. No dependencies, no network, deterministic.
