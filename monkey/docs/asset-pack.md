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
