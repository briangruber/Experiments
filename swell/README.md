# swell

A Three.js ocean cut into six replaceable parts, with a harness that can say
objectively whether your version of a part is cheaper, steadier, and closer to
measured ocean physics than the current one.

Everyone with an agent is building this same ocean from scratch and then tuning
it alone for a week. The tuning is the valuable part, and it is being thrown
away every time. Here a tuned part is a file, and a file can be compared against
the file it is trying to replace.

## Running it

Serve this folder and open `index.html`; there is no build step.

```
npx serve .          # or: python3 -m http.server
```

Four scenes — Golden Hour, Deep Ocean, Hurricane, Sandy Beach — a variant picker
per slot, and every knob on a slider. **Copy tuning as JSON** emits only what you
changed, which is the thing to hand your agent.

## Improving it

Read [AGENTS.md](AGENTS.md). Short version: copy the champion variant for one
slot, edit it, then

```
node tools/evaluate.mjs --slot breaking --variant my-idea
```

which renders the whole fixture matrix twice — champion and candidate, identical
camera, sun, wave phase and simulation time — and writes a submission directory
with before/after frames, `report.json`, and a `sheet.html` that puts the two
under a wipe slider.

Also useful:

```
node tools/shot.mjs --scene hurricane --time 19.5 --out shots/storm.png
node tools/bench.mjs --slot spectrum=sine-sum
```

`shot.mjs` exits non-zero on any shader or JS error, so it doubles as a smoke
test.

## What "better" means here

Two halves, kept apart on purpose.

**Measured.** Gates that reject outright — runs clean, renders deterministically,
does not shimmer. Then numbers that are reported but never summed into a score:
frame cost, and conformance against real oceanography — significant wave height
against the fetch-limited energy growth law, whitecap coverage against Monahan &
O'Muircheartaigh, spectral tail slope against Phillips' saturation range. Those
are read back from the shader that actually ships, not from a JavaScript model
of it, so they cannot be satisfied by a variant that renders nothing.

**Preference.** Whether it looks right. Nothing here will assert that, and you
should distrust any version of this project that starts to. It is settled by
people and models looking at identical frames.

Champions are per **cost budget** — `lean`, `standard`, `lavish` — so "prettier
but twice the price" is a different rung on the ladder rather than an argument
nobody can win.

## Layout

```
index.html            the viewer
src/slots/            the six slots and every variant of them
src/slots/contracts.js  the seams — authoritative
src/scenes.js         the four fixtures, pinned
src/knobs.js          every knob, and the sparse-override rules
tools/evaluate.mjs    champion vs candidate
tools/harness/        collection, metrics, scorecard, review sheet
domain.json           what the harness renders and measures
champions.json        the current stack per budget, and how it got there
```

## Known deviations

Recorded rather than hidden, because the harness measures them on every run and
they are the most obvious things for someone to come and fix:

- **Spectral tail is too steep.** The champion spectrum measures around `k^-3.5`
  to `k^-4.3` where Phillips says `k^-3`. The short trains fan too far off the
  wind, which smears their energy toward lower wavenumbers on a transect. A
  narrower high-frequency spreading function is the obvious fix and nobody has
  written it yet.
- **Whitecap coverage is fitted, not derived.** Coverage is set by thresholding
  the fold field at the level whose exceedance probability matches Monahan's law,
  which works, but the fold field is not quite Gaussian and needs an empirical
  `foamSigma` of 1.25 to land. A breaking model that did not need the fudge would
  be a real improvement.
- **A grey lens-shaped blob appears near t = 0.** Visible in the viewer's opening
  frame on the hurricane scene at large viewports, gone by the time the fixtures
  sample at t = 7 s, which is why none of the stored comparisons show it. It is
  flat and hard-edged, so it is more likely a degenerate case in the shading than
  a wave — the wave phases are all near their seeds at t = 0. Not diagnosed.
- **The beach is the weakest scene.** Shoaling, refraction and the depth-limited
  break all work, but the sand is untextured at grazing angles and the waterline
  aliases.

