# Contributing to swell

This file is written for an agent. If you are a person, it still applies — you
will just be asking your agent to do most of it.

## What this project is

One Three.js ocean, cut into six replaceable parts, with a harness that can say
objectively whether your version of a part is cheaper, more stable, and closer
to measured ocean physics than the current one.

It exists because everyone with an agent is currently building the same ocean
from scratch and then tuning it alone. The tuning is the valuable part and it is
being thrown away. Here it is not: a tuned part is a file, and a file can be
compared against the file it is trying to replace.

## The six slots

Each slot is a contract — a set of GLSL functions a variant must define. The
contracts live in `src/slots/contracts.js` and that file is authoritative; what
follows is orientation.

| slot | defines | owns |
| --- | --- | --- |
| `sky` | `sw_sky`, `sw_sunRadiance`, `sw_skyAmbient` | the sky, and therefore all the light |
| `shoreline` | `sw_seabedHeight`, `sw_waterDepth` | bathymetry in world metres |
| `spectrum` | `sw_waves`, `sw_wavesN` | the wave field: displacement, normal, fold |
| `breaking` | `sw_breaking` | *where* whitecaps are |
| `foam` | `sw_foamShade` | what whitecaps *look like* |
| `water` | `sw_waterShade` | fresnel, absorption, subsurface, glitter |

Slots are assembled in that order and a variant may call anything defined by a
slot above it. The split between `breaking` and `foam` is deliberate and is the
one people get wrong: "where" and "what it looks like" are improved by different
people on different days, and fusing them is what makes foam untransplantable.

Two structs carry data across the seams. `Wave` is one sample of the field;
`Surf` is everything a shading slot knows about the point it is shading. Adding
a field to either is backwards compatible. Changing or removing one is not.

### The fold contract, specifically

`spectrum` must fill `Wave.fold` honestly: `1 - det(J)` of the horizontal
Jacobian, so that above 1 the surface has folded over itself. `breaking` spends
that number. A spectrum that leaves `fold` at zero will assemble, render, and
quietly make every breaking variant useless. There is no way to check this
automatically — it is the one place the system runs on good faith.

It must also fill `Wave.foldRms`: the RMS of that fold field, over exactly the
trains that survived this pixel's footprint. Phases are independent, so it is the
root of the summed variances — three extra lines inside the loop you are already
running. Breaking variants divide by it, and that division is the only reason a
single threshold can mean the same thing in a millpond and a hurricane. It cannot
be computed on the CPU, because only the shader knows which trains the footprint
kept.

### Two footprints, not one

The vertex stage filters wave trains at the *tessellation spacing* — geometry
cannot show a wave shorter than the gap between two vertices. The fragment stage
filters at the *pixel* footprint, which is far finer, and picks up every train
the mesh was too coarse to carry. Long waves are geometry; short waves are
normals.

Making both stages agree on one conservative footprint is the obvious thing to
do and it is wrong: at a hundred metres out it discards everything below about
eighteen metres, and the sea renders as smooth bands. If your variant looks
strangely calm, check which footprint it is being handed.

### `subRough`, and why filtering is not deletion

Wave trains shorter than a pixel must not be drawn, or the sea shimmers. They
must also not vanish, or the distant sea turns to glass. A spectrum variant is
required to accumulate the slope variance it filters out into `Wave.subRough`,
and shading variants fold that into their microfacet roughness. If you write a
spectrum and skip this, the `flicker` gate will pass and the ocean will look
dead at range.

## Adding a variant

1. Copy the current champion for the slot you want to improve:

   ```
   cp src/slots/breaking/fold-ridge.js src/slots/breaking/my-idea.js
   ```

2. Edit `meta`: give it a new `id` matching the filename, your name in `author`,
   a `source` URL, a `license`, and set `parent` to the id you copied. Provenance
   is not bureaucracy here — it is how a good idea gets traced back to whoever
   had it, across ten repositories that all started from the same prompt.

3. Register it: add the import and the array entry in `src/slots/index.js`.

4. Add knobs by putting them in the `knobs` export. A knob named `foamDrift`
   becomes `uFoamDrift` in GLSL and gets a slider automatically. Do not add
   uniforms by hand.

5. Change nothing outside `src/slots/<your-slot>/` and the one line in
   `index.js`. A submission that also edits the host, the scenes, or another
   slot cannot be compared against anything, because the thing it is being
   compared to no longer exists. If you genuinely need a host change, submit
   that separately and first.

## Proving it

```
node tools/evaluate.mjs --slot breaking --variant my-idea
```

This renders the full fixture matrix twice — once with the champion, once with
yours — at identical camera, sun, wave phase and simulation time, and writes
`submissions/breaking-my-idea/` containing `before/`, `after/`, `report.json`
and `sheet.html`. That directory is the whole submission.

### What is measured, and what is not

**Gates.** Fail one and nothing else matters.

- `errors` — no shader, WebGL or JS error on any fixture.
- `determinism` — the same fixture rendered twice is byte-identical. Read the
  wall clock or an unseeded random and you fail here, and rightly: a
  nondeterministic variant cannot be compared with anything, ever.
- `flicker` — two frames a 60th of a second apart, differenced and high-pass
  filtered. Catches "I turned the detail up and the screenshot looks amazing",
  which is the most common regression in this project.

**Measurements.** Objective, reported as numbers, never summed into a score.

- `cost` — median frame time. The absolute figure comes from a software
  rasteriser and is *not* a frame budget; the ratio against the champion is the
  number that travels between machines.
- `waveHeight` — significant wave height, against the fetch-limited energy growth
  law capped at the Pierson-Moskowitz fully developed sea. Measured over a 2 km
  patch, because a 350 m swell needs several wavelengths before the variance
  estimate settles down.
- `whitecap` — plan-view foam area fraction, against Monahan &
  O'Muircheartaigh's `W = 3.84e-6 · U10^3.41`, on a 512 m patch sampled every
  metre. Coverage is meaningless without a stated resolution.
- `spectralSlope` — slope of the wavenumber spectrum, fitted *above the spectral
  peak only*, against Phillips' `k^-3`. Straddling the peak fits a slope to a
  shape that has no slope.

Note that JONSWAP's own `alpha` fit and the significant-height growth law
disagree by about 1.7x. The champion spectrum resolves that by keeping JONSWAP's
shape and taking its total energy from the growth law, so `waveHeight` is a
conformance check against a stated reference, not a discovery. What it catches is
a variant that departs from the reference — a plain sine sum, or a regression.

The physics measurements are sampled from the shader that actually ships, via a
readback pass — not from a JavaScript model of it. You cannot satisfy them with
a variant that renders nothing.

For these, "better" means "closer to the reference", and the report says which
way you moved. Deliberate departure from physics is allowed and sometimes
correct; you just have to say so, because the number will show it.

None of these are gates. They are allowed to disagree with reality on purpose —
a stylised ocean is a legitimate thing to build — but the number will show it,
and you should say why in your pull request rather than let a reviewer find it.

**Not measured: whether it looks better.** Nothing in this repository will
assert that, and you should distrust any version of it that starts to. Looks are
settled by people and models looking at `sheet.html`, which puts your frame and
the champion's frame under a wipe slider with everything else held identical.

### The ladder is Pareto

Champions live in `champions.json`, one set per **budget** — `lean`, `standard`,
`lavish` — defined by a maximum cost ratio. A variant that looks better and
costs 2× does not beat one that looks worse and costs 0.5×; they win different
budgets. `report.json` lists which budgets your cost ratio makes you eligible
for. This is why `spectrum/sine-sum` and `breaking/slope-threshold` are in the
tree despite being plainly worse: they are the `lean` champions, and they are
supposed to be beaten by something equally cheap and less wrong.

## Submitting

Open a pull request containing your variant file, the one-line registration, and
the whole `submissions/<slot>-<id>/` directory. Do not delete a losing
submission — a variant that failed is a result, and the next person to have the
same idea deserves to find it already tried.

In the description, say what you were looking at when you decided the current
one was wrong. "The foam sat on top of the crest instead of trailing behind it"
is worth more than any number in the report, because it tells the next person
what to look for.

## Promotion

A variant becomes champion for a budget when it passes every gate, its cost
ratio fits the budget, and preference goes its way. Promotion appends to the
`ledger` in `champions.json` with a link to the submission that earned it, so
the current stack can always be read backwards into the arguments that produced
it.

## Tuning without writing code

If you only moved sliders, you do not need a variant. Open `index.html`, tune,
press **Copy tuning as JSON** — it emits only what you changed, against the
scene as published — and hand that to your agent along with what you were trying
to fix. A knob diff is a legitimate contribution: it can be proposed as a scene
change, or as new defaults for a variant, and it is frequently what a
"structural" improvement turns out to have been all along.
