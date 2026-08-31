# Character asset pack format

What to hand over so a character drops into the game without anyone touching
the engine. One PNG sprite sheet plus one JSON manifest, per character.

The engine already loads this shape (`src/art/sprite-actor.js`); a pack in this
format replaces the procedural sprite by adding one entry to `SPRITE_CAST` in
`src/game/dock.js`.

## The PNG

A uniform grid of cells, filled left to right, top to bottom.

| | |
|---|---|
| **Character height** | **48 pixels**, feet to top of the head, at native size |
| **Background** | fully transparent — real alpha, no matte, no checkerboard |
| **Edges** | hard. No anti-aliasing and no semi-transparent pixels anywhere |
| **Scale** | native. Do **not** upscale 2x/4x before sending |
| **Facing** | right. The engine mirrors for left |
| **Outline** | a 1px dark outline all the way round each figure |

Two rules matter more than the rest, because breaking either shows up as motion
rather than as art:

- **The feet sit on the same row in every cell.** A one-pixel difference reads
  as the character bobbing.
- **The figure is centred on the same column in every cell.** A one-pixel
  difference reads as sliding.

48 pixels is set by the room: the plate is 1280×720 and the character is drawn
at 3 screen pixels per art pixel, so 48 art pixels is a person about a third of
the way up the frame. That is the same relative size as the characters in *The
Dig* (~44px) and it is why a small head and long legs matter — roughly a
seventh of the height for the head, about half for the legs.

## The clips

| clip | frames | needed |
|---|---|---|
| `idle` | 1–4 | yes |
| `walk` | 8 | yes |
| `talk` | 2–4 | yes — mouth open/closed is enough |
| `idle_back`, `walk_back` | 1–4 / 8 | optional, and the biggest single upgrade |
| `idle_front` | 1–4 | optional |

The back-facing clips are worth calling out: right now turning upstage only
hides the face, because there is no back sprite. A character that can walk away
from camera is the difference between a room and a diorama.

The walk must be a **loop**: frame 8 leads back into frame 1. The engine drives
the phase from distance travelled, not from a timer, so the feet stay in step
with the ground at any speed — which only works if the cycle closes.

## The JSON

```json
{
  "cellW": 64,
  "cellH": 64,
  "cols": 8,
  "figureH": 48,
  "feetY": 60,
  "clips": {
    "idle": { "start": 0,  "count": 4, "fps": 6 },
    "walk": { "start": 8,  "count": 8, "fps": 12 },
    "talk": { "start": 16, "count": 4, "fps": 8 }
  }
}
```

- `cellW` / `cellH` — one cell, in pixels. Every cell the same size.
- `cols` — cells per row in the sheet.
- `figureH` — feet to top of head. The engine scales by this, so it can be off
  the nominal 48 and still land correctly.
- `feetY` — the row **within a cell** where the ground line is. This is what
  puts the character on the floor rather than floating over it.
- `clips[].start` — index of the clip's first cell, counting from 0 across the
  whole sheet.

## If that is awkward to produce

A folder of individual PNGs, one per frame, named `walk-01.png` … `walk-08.png`,
`idle-01.png`, `talk-01.png`, is also fine — the atlas and manifest can be built
from it, provided the two alignment rules above still hold within each clip.

## A warning about generating these

Frame-to-frame consistency is the hard part and image models are bad at it: ask
for eight walk frames and you get eight slightly different characters. What
works is generating **one** reference pose and producing the rest as edits of
that single image, or using a pack with genuinely hand-made frames. A pack whose
frames disagree about where the belt is will look worse than the procedural
sprite, however good any single frame is.

## PixelLab

`tools/pixellab.mjs` wraps [PixelLab](https://www.pixellab.ai/pixellab-api), which
is built for this and solves the failures above at the API level rather than by
prompting harder.

    export PIXELLAB_API_KEY=...
    node tools/pixellab.mjs balance
    node tools/pixellab.mjs character bonny --dry   # print the brief, spend nothing
    node tools/pixellab.mjs character bonny
    node tools/pixellab.mjs animate bonny walk
    node tools/pixellab.mjs sheet bonny

The reason it works is structural rather than a matter of quality. **A character
is a persistent entity**: you create it once and then ask for animations *of
it*, so the frames cannot drift into eight slightly different people the way
eight independent rolls do. Four more of the problems above are parameters
rather than hopes:

| the failure | the parameter |
|---|---|
| magenta backgrounds keyed by hand, gradients, a dark band under the feet | `no_background: true` — real transparency |
| a 1px outline asked for in prose and inconsistently drawn | `outline: "single color black outline"` |
| 8, 8, 8, 7, 6, 5 and 4 frames returned for one brief | `frame_count`, 4–16, even |
| no back-facing sprite, so turning upstage only hides the face | 8 directions, `directions: [...]` |

`view: "side"` matters and is set: this is a side-on room, and a character
generated top-down cannot be turned into one afterwards. Sizes run 32–256, so
the 48px figure this document asks for is native rather than something to
downscale into.

Rough cost: a Pro character is about $0.185 and animation frames $0.013–$0.042
per direction, so a character with a walk cycle in the directions the game
needs lands well under a dollar.

The output goes through the same cutter as everything else
(`tools/sheet-cut.mjs`), which still enforces the two alignment rules — the API
should make them true already, and the check is cheap.

## AutoSprite

[AutoSprite](https://autosprite.io) returns exactly the shape this document
asks for: a uniform grid — 5×5 cells of 256px in the sheets tested — with the
background already removed, per-animation (idle, walk, run, jump), plus an
atlas export.

`tools/autosprite.mjs` wraps it. Base URL `https://www.autosprite.io/api/v1`,
authenticated with `x-api-key: vspk_…`.

    node tools/autosprite.mjs account
    node tools/autosprite.mjs characters
    node tools/autosprite.mjs regen <characterId> --dry
    node tools/autosprite.mjs regen <characterId>
    node tools/autosprite.mjs pull <characterId>

Two things in the API matter more than the generation quality, and neither is
visible from the app.

**`frameSize` accepts 32–512.** Frames can be asked for at the size the game
draws them. Every previous route here made art large and reduced it, and
reducing a smooth source to forty pixels is the mistake this project has made
twice — baking a 3D mesh, then downsampling the vector puppet. Asking for 64
instead of 256 deletes the step rather than doing it better.

**`regenerate-spritesheets` is free.** It re-extracts from videos that were
already generated, at a different frame count, frame size, background removal
and sharpening. So sheets made in the app at its defaults — 25 frames, 256px —
do not need regenerating at cost. They need re-reading at game settings, which
is the same videos and no credits.

The defaults this tool sends are therefore 8 frames at 64px with `removeBg:
"ultra"`, against the app's 25 at 256 with `"default"`. Eight is a walk cycle;
25 frames is a two-second clip, because behind the API each animation is a
generated video that gets sampled — which also explains why the app's idle
sheet holds 25 near-identical poses.

That means the cutter needs none of its rescue machinery. `--grid` says the
sheet already is a grid, so the work reduces to measuring where the figure sits
inside each cell and re-packing at native resolution with the feet on one row:

    node tools/sheet-cut.mjs <sheet.png> --name bonny --grid 5x5 --down 4
    node tools/check-cut.mjs        # the alignment rules, on a fixture built to break them

`--down N` reduces by the block size to get back to native pixels, since a 256px
cell is pixel art drawn large. `tools/pixel-grid.mjs` measures what N should be.

The cutter now verifies the file it just wrote — feet spread and head spread
across every cell, printed, and a non-zero result fails the run. Enforcing a
rule and checking it are different things, and only the second survives a
refactor. `tools/check-cut.mjs` builds a sheet designed to break both rules
(heights varying 12px, placement varying 18px) and asserts the output has zero
spread; a real sheet that happens to be well aligned would prove nothing about
the code.

Sheets can live anywhere now — an uploads directory, /tmp, another checkout —
because the image is handed to the page as a data URI rather than served from
inside the repo.
