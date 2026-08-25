# Boat wakes — rapid prototype

A stripped-down three.js rig for one job: getting the *look* of a planing boat's
wake right, fast, with every parameter on a slider.

    npx serve .        # or any static server
    open http://localhost:3000

`drag` orbit · `wheel` zoom · `double-click` reframe · `T` top-down ·
`A/D` steer · `W/S` throttle · `F` show the raw wake buffer · `H` hide UI

On touch: one finger orbits, two fingers pinch to zoom and twist. The control
rail is a bottom sheet, closed on load so the canvas gets the whole screen.

## How it works

The whole wake is **re-drawn from scratch every frame**. Nothing accumulates.
That is the point: move any slider and the entire wake — right back to the
horizon — updates on the next frame, instead of having to be flushed and
regrown. It makes tuning a conversation instead of a wait.

    boat path history  →  ribbon mesh  →  wake field texture  →  ocean shader
    (positions + time)    (arc/lat/age)   (foam, height, flatten)

1. **Path history** (`wakeField.js`) — the bow position is recorded every 1.4 m.
2. **Ribbon mesh** — a strip laid along that path. Every vertex carries how far
   astern it is (`arc`), how far off the centreline (`lat`), how old it is
   (`age`), and the path tangent frozen in at birth.
3. **Ribbon shader** — draws the whole wake procedurally from those numbers into
   a top-down float texture that follows the boat:
   `R` foam · `G` displacement · `B` swell flattening · `A` subsurface bubbles.
4. **Ocean shader** (`ocean.js`) — one texture lookup. The wake composites with
   no seams, and no wake maths lives in the water shader.

## What the wake is made of

Read from the reference footage, and each piece is a separate slider group:

| Piece | What it is |
|---|---|
| **Spray arms** | The V. Springs from the **bow**, not the transom. Hard bright outer rim, soft combed inner edge — that asymmetry is most of the read. |
| **Feathering** | Periodic crests leaning back off each arm, lengthening with age. Confined to the arm's inner edge; the outer face stays continuous. |
| **Prop wash** | Turbulent water off the transom. Brightest foam in the wake, shortest-lived. |
| **Inside the V** | Flattened water carrying the transverse wave train. |
| **Subsurface bubbles** | Air the prop drags *under* the surface. Not foam — see below. |
| **Foam motion** | The lace surges with the swell, shears in the churn, and its cells burst and re-form — all as local motion. |
| **Foam texture** | A reticulated bubble raft (noise contours) + flow-aligned streaks. |
| **Foam on water** | How the foam sits *in* the water rather than on it: aeration halo, opacity build, translucency, relief, trough pooling. |

Foam noise is sampled in **world space**, so bubbles stay locked to the water
instead of swimming along with the boat.

### Above and below the surface

The prop is underwater, so most of the air it entrains never surfaces as foam.
It stays as a plume in the water column, wider and much longer-lived than the
white above it, and it behaves nothing like foam:

- It scatters light back **through water**, so it takes the water's colour
  brightened toward turquoise — never white.
- It does not break the surface, so the water above it goes on reflecting the
  sky and catching the sun exactly as before.

So it is resolved as part of the **water body colour**, before the surface is
applied — a bubble plume works like a bright scattering floor, stopping light
escaping down into the dark, which is the same reason water over sand reads
shallow and turquoise. Surface foam is composited after, on top.

That ordering is the whole trick. Tint the water *after* adding reflection and
specular and you get a flat turquoise decal; tint the body *before*, and the
glints ride over the churn the way they do in real footage.

### Keeping the lace alive without letting it drift

Foam noise is world-locked, which is right — but it also makes it frozen.
Animating it has one hard constraint: every motion must be a *bounded local
offset*. Anything with a net translation slides the foam across water it is
supposed to be floating on, which reads worse than no animation at all.

Three motions, none of which translate:

- **Surge with the swell.** Water in a wave moves in orbits, and the horizontal
  part of that orbit follows the surface slope — already computed for the
  normal, so this costs nothing and is automatically coherent with the waves.
- **Turbulent shear.** A warp field whose own sample point travels a *circle*
  rather than a line, so it evolves without going anywhere.
- **Cells burst and re-form**, by the same circling trick applied to the lace
  coordinates.

Two traps here, both found the hard way. Cell size must come from the sampling
scale, never from scaling the sample position by a per-pixel quantity like foam
— scaling coordinates by something that varies in space warps the noise along
that quantity's gradient, and the lace snaps onto iso-contours of foam, reading
as a contour map. And the lattice is a *ridge* function: thresholding it
directly gives nested outlines, not cells, so it belongs as an accent on smooth
noise rather than as the field itself.

`tools/motion.mjs` measures this: change between frames (is it animating?) and
foam-centroid shift (is it drifting?). Run `--still` as a control — with the
motion parameters zeroed, change must be zero. Note it flattens the swell
first: moving water changes the shading under perfectly static foam, and that
baseline is large enough to swamp what is being measured. It also advances sim
time explicitly rather than waiting — `dt` is clamped per frame, so on a
headless renderer at ~2 fps a two-second wait buys a fraction of a second of
animation and a working lace reads as a dead one.

`tools/probe.mjs` reads the field texture directly and prints a lateral slice,
counting wash channels by prominence. Foam saturates to white on screen, so
structure has to be counted in the data: `--expect N` asserts N channels for N
engines.

### Where the foam is decided

Split deliberately across the two stages:

- The **ribbon** bakes *structure* — arms, comb, wash, age — as smooth,
  continuous coverage. Nothing here thresholds, so nothing here can produce a
  hard edge.
- The **ocean shader** shades *texture* — the bubble lace — per-pixel, using
  coverage to slide a threshold through a fine noise field. Dense foam takes
  all of it; thin foam keeps only the cell walls; the transition between is the
  lacy fringe.

The split exists because the field texture is ~0.33 m per texel, which is
coarser than lace: baking it produces visible squares up close. Shading it
costs nothing on the ~90% of the screen that is open water.

Opacity then builds as `1 - exp(-foam · density)` — Beer-Lambert for an
accumulating scattering layer — so foam approaches white asymptotically instead
of landing on a cut-out edge, and thin lace keeps some of the colour of the
water beneath it.

Note the two pixel footprints in the ocean fragment shader. Waves cannot be
shown finer than the mesh carrying them, so their LOD is floored at the vertex
spacing; foam lace is pure shading with no geometry behind it, so it uses the
true screen footprint. Feeding the floored one to the lace blanks it entirely.

## Tuning loop

Move sliders → **Copy params** → paste the JSON into a conversation. **Paste
params** puts a state back. Everything is also settable by URL:
`?arms.angle=18&boat.turnRate=6`.

## Headless captures

    node tools/motion.mjs            # lace animates in place
    node tools/motion.mjs --still    # control: nothing else may animate it
    node tools/motion.mjs --drift    # the swell-surge term is live

    node tools/shot.mjs --out shots/a.png --cam -1.5708,0,150
    node tools/shot.mjs --out shots/turn.png --set boat.turnRate=6 --prewarm 120

`--prewarm N` runs N seconds of boat *before* the first frame, so a capture
starts with a full-length wake. The sim is stepped independently of rendering —
without that, a slow headless frame rate silently shortens the wake.

Exits non-zero on any WebGL/JS error, so it doubles as a smoke test.

## Performance

The Performance group sets render scale and ocean tessellation. Both are
auto-set on load — phones and >2x displays start at scale 1 / 260 segments —
and both stay editable.

The fragment shader is the cost centre: it evaluates the surface height for
normals as well as for displacement. The swell's gradient is computed
analytically rather than by finite differences, which is what keeps that from
being four extra evaluations of the whole wave sum per pixel. Only the wake
texture is differenced, since a fetch is cheaper than another pass over the
waves.

## Known gaps

- Overlapping wake in a tight turn adds foam additively, so it over-brightens.
- The wake field is a 340 m window that follows the boat; wake older than that
  falls off the back.
- Water is deliberately plain — anything interesting in a shot is the wake.

`ref/` holds the frames pulled from the source footage for comparison.

## Testing it in a browser

The whole prototype bundles into one self-contained HTML file:

    node tools/artifact.mjs --out dist/wake-lab.html
    node tools/verify-bundle.mjs      # loads it the way a host will; non-zero on failure

There is no build tool here, and three.js ships as two files that import each
other by relative path. Rather than flattening the module graph, the bundler
rehosts it: every module becomes a Blob URL and each import specifier is
rewritten to point at its dependency, created in dependency order. ~780 KB.
