# Experiments

A collection of independent graphics and game prototypes. **One folder per
prototype, at the top level.** Nothing lives at the repository root except this
file and shared configuration.

That rule exists because the alternative was already causing damage: with one
prototype occupying the root, another branch had replaced the root `index.html`
with its own entry page, and a third had dropped its build scripts into the
shared `tools/`. Each prototype owning a folder means two of them can never
collide, and a branch can be merged without reading it first.

## Prototypes

| folder | what it is |
| --- | --- |
| `ocean/` | Abyssal — a real-time cinematic ocean simulator with a rideable wave runner. Multi-cascade FFT sea, volumetric clouds, GPU spray, persistent Kelvin wake. |
| `tiny-worlds/` | Tiny Worlds — a Three.js game about waking five hand-sized planets. Radial gravity, a bloom wavefront that greens a whole world, flights between planets that share one scene. Models generated with the Tripo API. |

Other prototypes currently live on their own branches and follow the same
convention (`harbor/`, `boats/`, `cozy-fishing/`). They can be merged here as
they stabilise.

## Layout of a prototype

Each folder is self-contained — its own entry point, sources, and build and
capture tooling — so it can be opened, built and run without reference to
anything outside it:

```
<prototype>/
  index.html      entry point, opened directly or served
  src/            sources
  tools/          build, capture and measurement scripts
```

## Running one

Serve the prototype's folder and open `index.html`; there is no build step for
development. For `ocean/`, the capture and measurement harness lives in
`ocean/tools/`:

```
cd ocean
node tools/bundle.mjs --root . --out dist/abyssal.html   # single self-contained file
node tools/shot.mjs --out shots/frame.png --w 1280 --h 720
```

`tools/shot.mjs` exits non-zero on any WebGL or JS error, so it doubles as a
smoke test.
