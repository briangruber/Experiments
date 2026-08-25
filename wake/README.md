# Boat wakes — rapid prototype

A stripped-down three.js rig for one job: getting the *look* of a planing boat's
wake right, fast, with every parameter on a slider.

    npx serve .        # or any static server
    open http://localhost:3000

`←/→` steer · `↑/↓` throttle · `Shift` hard turn · `drag` orbit · `wheel` zoom ·
`double-click` reframe · `T` top-down · `F` raw wake buffer · `H` hide UI

The throttle moves a *target*; the hull has inertia and takes seconds to reach
it. That matters for more than feel — see below.

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
| **Inside the V** | Flattened water. |
| **Kelvin waves** | The gravity waves. Displacement only, so they roll on long after the foam has died, and they reach the full 19.47° wedge — wider than the spray arms. |
| **Subsurface bubbles** | Air the prop drags *under* the surface. Not foam — see below. |
| **Foam motion** | The lace surges with the swell, shears in the churn, and its cells burst and re-form — all as local motion. |
| **Foam texture** | A reticulated bubble raft (noise contours) + flow-aligned streaks. |
| **Foam on water** | How the foam sits *in* the water rather than on it: aeration halo, opacity build, translucency, relief, trough pooling. |

Foam noise is sampled in **world space**, so bubbles stay locked to the water
instead of swimming along with the boat.

### Foam is where waves break

The foam V used to be a *drawn shape* — a half-angle slider, set to whatever
looked right, with no connection to the waves at all. Two independent systems
sitting on top of each other, and only the waves had any physics in them.

Foam is now derived from the wave field: steepness is amplitude × wavenumber,
and past a critical value a crest spills. That one change makes the foam inherit
the wave field's own geometry — it lands on the cusp line where the divergent
and transverse systems merge and the amplitude piles up, and it follows speed,
Froude number, hull length and turn rate without being told to, because all of
those are already in the local amplitude. It also sits on the crest faces rather
than in the troughs.

`Foam from breaking` crossfades between the derived foam and the old prescribed
arms, so the two can be compared directly. The prescribed arms are kept because
spray thrown by a planing hull is genuinely not the same phenomenon as a
gravity wave breaking — but the V should come from the waves, and now does.

### Wave size comes from the hull, not from a slider

Kelvin amplitude is computed from the boat rather than dialled in:

- **Length Froude number**, `Fr = V / sqrt(gL)`. Wave-making is not linear in
  speed — it climbs, peaks near hull speed where the hull is trapped between its
  own bow and stern crests, then falls away as it lifts and planes — but floored,
  not decayed to nothing. Past the hump a hull's wave-making *resistance* does
  collapse, yet a planing boat plainly still leaves a wake; without the floor the
  waves switched off entirely at ordinary planing speeds (`Fr = 1.4` on an 8.5 m
  hull put the term at 0.01), which `coast.mjs` caught as a dead flat sea.
- **Bow/stern interference.** Both ends raise their own system, separated by the
  hull's length, and they add or cancel depending on how many wavelengths fit
  between them. These are the humps and hollows in a hull's resistance curve —
  why a given hull has speeds that feel cheap and speeds that feel expensive.
- **Beam** scales it: a beamier hull pushes more water aside.
- **Turn rate**, carried per path sample, runs the outside of a curve bigger
  than the inside.
- **Acceleration** needs no special term: since every sample carries the speed
  it was made at, the wake behind an accelerating boat is genuinely not
  self-similar — the wavelength shortens towards its tail on its own.

### Speed, and why the wake has to remember it

Every source scales by the speed the boat was doing **when it passed that spot**,
carried per path sample, not by its speed now. Spray arms need planing speed to
exist at all — below it a hull pushes water aside rather than throwing it — so
they fade out entirely at low speed, leaving a narrow displacement-mode trail.

Two consequences worth stating, because both were bugs first:

- Without inertia, a slider step made the emission step too, laying a wake that
  went from nothing to full strength in one frame and left a straight cut across
  the water. The hull now accelerates.
- The Kelvin phase must not be anchored to `arc`, the distance behind the boat
  *now*. That ties the whole pattern rigidly to the hull, so slowing down
  freezes waves already on the water. The steady solution is steady for a source
  that *kept going* at the emission speed, so the anchor is `V_emit × age`.
  Identical at constant speed; they part company exactly when they should.

`tools/coast.mjs` stops the boat dead and checks the water keeps moving.
`--locked` is the control: with the pattern pinned to the hull it measures 0%
change, which is precisely the bug. `tools/accel.mjs` opens the throttle from
rest and checks the wake builds, and that `maxArc` tracks distance travelled —
if the wake were stuck to the boat, it would not.

### The Kelvin system

Solved rather than faked. A wave train at angle ψ to the track has
`k = g/(V² cos²ψ)` and reaches the point (u astern, v abeam) with phase
`k(u cos ψ + v sin ψ)`. Stationary phase in ψ reduces to

    2v·T² + u·T + v = 0,     T = tan ψ

whose two roots are the divergent and transverse systems. Real roots require
`u² ≥ 8v²` — the 19.47° wedge, arriving out of the algebra rather than being
drawn on. The two roots merge at the wedge edge, which is why the cusp line is
the brightest feature of a real wake.

Because these are displacement and carry no foam, they need their own life:
multiplying them by the foam's decay (which is what happened first) kills them
exactly where they are supposed to take over.

Two resolution limits bite here. The divergent system runs to arbitrarily short
waves as ψ → 90°, so anything shorter than the field texture can carry is faded
out at its own local wavelength, or it becomes moiré. And at 1024 over a 340 m
window (~0.33 m/texel) the cusp lines visibly stair-step; 2048 fixes it, so
desktop gets the larger field and phones keep the smaller one.

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

## Why the sea washes out from a low angle

At a shallow angle most of what you see is reflected sky, so the sea goes pale
and the wake stops reading against it. That is correct physics, not a bug — but
`Water & light → Mirror / reflectivity` scales it, and it is the single biggest
lever when nothing is visible.

Two things had to match between the detailed plane and the far water, and both
showed up as a rectangle drawn on the sea until they did:

- Specular fades out at the plane's rim along with the waves. The far water has
  none, so carrying it to the edge leaves a step exactly on the join.
- The diffuse term. The detailed plane adds `deep × N·L × 0.25`; without the
  same term the far sea sat about a fifth darker.

Sampling a vertical profile across the join is the quickest way to find these —
a step of four luma units is invisible to reasoning and obvious in a column of
numbers.

## Making it die faster

`Field & decay → Wake decay ×` scales every lifetime and decay length at once,
in seconds and in metres. The individual controls stay where they are (foam
life, bubble life, wave life, the arm fade, the wash and plume decay lengths) —
this multiplies all of them, because "make it die faster" should not mean
hunting through four groups.

## Holding up close in

Three separate things terraced a close-up, none of them the same fix:

- **The ocean mesh.** At 520 m across, its vertices sit 0.93 m apart — nearly
  sixty pixels in a close-up, which faceted the whole wake.
- **The wake field's texels.** Plain bilinear is only C0: its iso-contours run
  along texel diagonals, and the foam threshold turns that into a sawtooth on
  every edge. Easing the fractional part before the lookup makes it C1 for a few
  instructions and the same single fetch.
- **The Kelvin wedge boundary**, which is a hard on/off in the maths where the
  discriminant crosses zero. Baked straight in, it leaves a jagged diagonal one
  texel wide. It is ramped over a small band of the discriminant now.

The first two are fixed by *shrinking* rather than by adding resolution: zoomed
in you cannot see the far wake anyway, so both the field window and the ocean
plane contract with the camera, putting the samples where you are actually
looking. That costs nothing here precisely because nothing accumulates — the
field is re-baked from the path every frame, so there is no state to invalidate
when the window changes size. `Field & decay → Shrink field on zoom-in` controls
it; the plane is quantised into a few buckets so it rebuilds rarely.

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
