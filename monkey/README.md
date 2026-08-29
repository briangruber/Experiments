# The Errant Kipper — an adventure-game slice

A one-room point-and-click adventure in the shape of *The Curse of Monkey
Island*, built to answer one question: **can a generated-asset pipeline
actually produce this genre, and where does it break?**

It is playable now. Serve this folder and open `index.html`.

```
node tools/check.mjs            # plays the room to the end, headless
node tools/plate.mjs blockout   # render the composition (free)
node tools/plate.mjs paint      # repaint it through fal (one credit)
node tools/voices.mjs --dry     # what recording would cost
node tools/voices.mjs           # record and measure the script
```

## What is here

One room, a four-step puzzle chain, and one conversation — deliberately the
smallest thing that still exercises every system a full game needs.

Take the boat hook from the nets → knock the tin cup off the tavern wall with
it → fill the cup at the grog barrel → give it to Harbourmaster Grout, who
falls asleep → walk the pier he was blocking and board the ship.

That chain is not decoration. It is an item you cannot reach, an item that
transforms, an NPC gate, a dialogue tree, and a world change that opens new
floor — the five things every later room is made of.

| system | file | note |
| --- | --- | --- |
| walk areas, A\*, string pull | `src/engine/pathfind.js` | polygons rasterised to a mask, so a floor can be traced loosely or extracted from an image |
| actors | `src/engine/actor.js` | stand, walk, say, face — four verbs, nothing else |
| room: scale, occlusion, parallax | `src/engine/room.js` | the three annotations that make a painting a place |
| interaction sequencer | `src/engine/script.js` | generators; a puzzle step reads like its own choreography |
| puzzle dependency graph + linter | `src/engine/puzzle.js` | unwinnable states are a graph property, so they are caught at load |
| verb coin, inventory, dialogue | `src/engine/ui.js` | CMI's three-verb coin, on the same canvas as the game |
| in-game annotation editor | `src/engine/editor.js` | press `` ` `` — drag the floor, export the polygons |
| placeholder art | `src/art/paint.js` | procedural, and also the conditioning signal for generation |
| the room itself | `src/game/dock.js` | data plus generator functions; touches no engine internals |
| the voiced script | `src/game/lines.js` | words only, with stable ids |

## What the tools turned out to be worth

The question was whether Meshy, Tripo, ElevenLabs, fal and the Vercel AI
Gateway help. Having built it:

**fal — decisive, and for a specific reason.** Not "generate a backdrop":
*repaint a blockout*. `tools/plate.mjs` renders the room's own procedural art
at full size and sends that image to `fal-ai/flux/dev/image-to-image`, so the
composition, horizon, light direction and — critically — the floor line come
back where they started. A text-to-image backdrop is a beautiful picture whose
floor is in the wrong place, and every one of those costs an hour of
re-annotation, per room, forever. Image-to-image does not have that problem.
This also settles provider choice: fal preserves the input's exact dimensions,
so a 1920×720 room stays 1920×720.

**The Vercel AI Gateway — real, but not for this.** Its image endpoints emit
fixed aspect ratios (1024×1024, 1536×1024). A 1920×720 room comes back
reframed, which destroys the alignment the blockout exists to protect. It is
kept in `tools/plate.mjs` behind `--provider gateway` for square-ish plates,
and it is the right tool for the LLM side — an authoring copilot, puzzle-graph
proposals, localisation. It is not the asset plane.

**ElevenLabs — yes, and the measuring matters more than the voices.** 22 lines,
50 seconds, recorded and measured in one command. The durations are what pay:
"No." is 0.70s and the line after it is 4.37s, and neither matches what the
text-length estimate guessed. Comic timing is the entire genre and it is
unjudgeable against an estimated clock. This is worth doing months before any
human actor is booked.

**Meshy and Tripo — not used here, and that is the finding.** The 3D-proxy
route exists to give a generated backdrop correct perspective and occlusion.
But for a single 2D room, the blockout that provides those things is fifty
lines of canvas code that the game already runs. Mesh generation earns its
place when a room needs a camera move, when a prop must rotate on screen, or
for character turnarounds to keep a cast on-model — not for making a flat
backdrop stand still. `telenovela/` already uses Tripo well for exactly the
case where it does pay.

## The thing that actually broke

The first plate was generated with the interactive props included. Large
geometry survived the repaint: the dock floor line, the tavern mass, the
pilings, the moon. Small objects did not. The tin cup drifted off its own
hotspot, the crates became a woodpile, and the tavern sign — "THE BILGE" —
came back reading "Jeavern".

So the rule the prototype settled on: **the plate carries static scenery only.
Anything the player can click stays a sprite the engine draws over it**, where
its position is a number in a file rather than a hope about a diffusion model.
`tools/blockout.html` excludes the props for this reason, and the props are
still drawn by `src/art/paint.js` on top of the generated painting. It is
visible in the screenshot: painted backdrop, code-drawn barrel and crates and
nets, each sitting exactly on its hotspot.

The cost is a style seam — flat vector props against a painted background —
and that is the next real piece of work: props generated individually through
the same style LoRA, cut out, and composited. That is a fal job, not a new
engine.

## What is still missing

- **Character animation.** The actors are procedural cartoon vectors with a
  walk cycle. Nothing on the tool list produces charming cel animation; the
  realistic routes are skeletal 2D (Spine) or 3D actors under a toon shader.
- **Props in the plate's style.** See above.
- **A second room, and room transitions.** The engine has no room graph yet.
- **Music.** Nothing on the list covers it, and iMUSE-style adaptive scoring
  was a signature of the series.
- **Writing and puzzle design.** Still the whole game.

## Checks

`tools/check.mjs` plays the room to completion in headless Chromium by
clicking real pixels — through the verb coin, the inventory and the dialogue
menu — and exits non-zero on any page error. It is the regression test: a
renamed flag or a broken verb fails it immediately.

It has already earned its place. It found the verb coin clearing its own
target before the verb ran (every verb silently did nothing), and the empty
inventory strip swallowing clicks on the lowest third of the screen.

## Provenance

`assets/provenance.json` records the model, prompt and source image behind
every generated asset, and `assets/voice/manifest.json` carries a hash of the
text and voice settings each clip was recorded from — so re-running a tool
only re-spends on what actually changed.
