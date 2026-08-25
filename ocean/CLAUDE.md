# Abyssal — project notes for Claude

Read [`AGENTS.md`](AGENTS.md) first: it is the canonical guide for both using
this package and working on it (entry points, pitfalls, the check-per-subsystem
table, the repo map). This file only adds what is Claude-specific or too
operational for that document.

- **Verification culture:** do not call a change done until the check for the
  subsystem you touched passes (the table in AGENTS.md). If no check covers
  your change, write a probe page in `prototypes/` and wire it to
  `tools/run-probe.mjs` — probes double as regression tests here.
- **TSL work:** read `docs/tsl-porting-rules.md` before touching
  `src/gpu/tsl/`. Comments citing rule numbers are load-bearing.
- **Golden drift:** if a rendering change is intentional, regenerate the
  affected `test/golden/*.json` in the same commit and explain the visual
  delta in the commit message.
- **Bundles are gitignored build products** (`dist/`): rebuild with
  `npm run build` / `npm run build:three`; never hand-edit them, and verify a
  bundle actually contains new code (grep for a new symbol) before publishing
  it anywhere.
- Commit messages in this repo explain *why* and what was measured, not just
  what changed — match that.
