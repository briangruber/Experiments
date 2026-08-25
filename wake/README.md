# Boat wakes — rapid prototype

A stripped-down three.js rig for one job: getting the *look* of a planing boat's
wake right, fast, with every parameter on a slider.

    npx serve .        # or any static server
    open http://localhost:3000

`drag` orbit · `wheel` zoom · `T` top-down · `A/D` steer · `W/S` throttle ·
`F` show the raw wake buffer · `H` hide UI

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
   `R` foam · `G` displacement · `B` swell flattening.
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
| **Foam look** | A reticulated bubble raft (noise contours) + flow-aligned streaks, thresholded by coverage — so dying foam thins into cell walls rather than dimming flat. |

Foam noise is sampled in **world space**, so bubbles stay locked to the water
instead of swimming along with the boat.

## Tuning loop

Move sliders → **Copy params** → paste the JSON into a conversation. **Paste
params** puts a state back. Everything is also settable by URL:
`?arms.angle=18&boat.turnRate=6`.

## Headless captures

    node tools/shot.mjs --out shots/a.png --cam -1.5708,0,150
    node tools/shot.mjs --out shots/turn.png --set boat.turnRate=6 --prewarm 120

`--prewarm N` runs N seconds of boat *before* the first frame, so a capture
starts with a full-length wake. The sim is stepped independently of rendering —
without that, a slow headless frame rate silently shortens the wake.

Exits non-zero on any WebGL/JS error, so it doubles as a smoke test.

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
