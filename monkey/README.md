# The Errant Kipper — an adventure-game slice

A one-room point-and-click adventure in the shape of *The Curse of Monkey
Island*, built to answer one question: **can a generated-asset pipeline
actually produce this genre, and where does it break?**

It is playable now. Serve this folder and open `index.html`.

```
node tools/check.mjs            # plays the room to the end, headless
node tools/check.mjs --bundle   # the same, against the single-file build
node tools/bundle.mjs           # -> dist/monkey.html, self-contained

node tools/plate.mjs blockout   # render the composition (free)
node tools/plate.mjs paint      # repaint the scenery through fal
node tools/props.mjs            # repaint each clickable prop, cut to its matte
node tools/props.mjs --rematte  # re-cut from the saved repaints, no spend
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
| moving layers | `src/art/animate.js` | drifting clouds, sea shimmer and moon glitter, candle flicker |
| prop table and mattes | `src/art/props.js` | the box each clickable object lives in |
| single-file bundler | `tools/bundle.mjs` | module registry + inlined assets, publishes as an artifact |
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

**Meshy and Tripo — still not used, and that is the finding.** Nothing in this
prototype is 3D, including the characters. The 3D-proxy
route exists to give a generated backdrop correct perspective and occlusion.
But for a single 2D room, the blockout that provides those things is fifty
lines of canvas code that the game already runs. Mesh generation earns its
place when a room needs a camera move, when a prop must rotate on screen, or
for character turnarounds to keep a cast on-model — not for making a flat
backdrop stand still. `telenovela/` already uses Tripo well for exactly the
case where it does pay.

## The rule this prototype exists to have found

**A repaint holds large geometry and loses small objects.** It was established
three times, each time more expensively than the last, and it is now the shape
of the whole pipeline.

The first plate included the props. The dock line, the tavern mass, the pilings
and the moon all survived; the tin cup drifted off its own hotspot, the crates
became a woodpile, and the sign — "THE BILGE" — came back reading "Jeavern".
So the props came out of the plate.

The second plate ran at a strength high enough to actually look painted rather
than vector, and at that strength the tavern's door vanished and its sign
moved. The door, the window and the sign are three hotspots. So the tavern came
out of the plate too.

What is left in the plate is now exactly the set of things nobody clicks: sky,
sea, horizon, pilings, planks. Everything else is generated one object at a
time and placed in a box we chose (`src/art/props.js`), so **a prop can be
regenerated fifty times and never cost a single re-annotation.** That is the
property that makes the pipeline scale to forty rooms rather than one.

### Cutting the props out

The obvious way to get alpha on a generated prop is a background remover. It
was tried, and it cut the tavern down to its lit window — a segmentation model
finds the salient object, and a building's salient object is the bright bit.

There is no need for a model. The blockout draws each prop on transparent, so
its own alpha *is* the silhouette the hotspots were authored against; the
repaint is composited onto flat grey only so the model has something neutral to
paint against, and the same matte is re-applied afterwards. Exact, free, and
the same insight as the plate one level down: the geometry was never lost, only
painted over.

One caveat, learned from a pile of rope: an exact matte is right for a solid
object and wrong for a wispy one. The blockout draws a net as a few thin
strokes, and cutting to that exactly returned a handful of scribbled strands.
Wispy props get their matte dilated first (`DILATE` in `tools/props.mjs`).

## Making the still image move

A flat image is what most gives away a 2D scene as a picture rather than a
place, and cutting the plate back into moving layers is free for the same
reason the repaint held its composition — `SCENE` in `src/art/paint.js` still
knows where the horizon and the dock line are.

- **Clouds** drift at two depths and pass *behind* the tavern, because the
  tavern is a sprite drawn above them rather than part of the backdrop.
- **Water** redraws the sea band from the plate in strips with a swell whose
  amplitude ramps to zero at the horizon — distant water barely moves, near
  water moves most, which keeps the horizon line crisp — plus moon glitter
  flickering out of phase, which is the single cue that reads as water.
- **Lamplight** flickers on two detuned sines with a rare dip, and spills onto
  the planks.

Three bugs in this pass were all the same bug: **a gradient clipped by a
rectangle is a rectangle.** The lamp spill, and then the character's rim light,
both drew a gradient into a `fillRect` under `lighter` compositing — and since
a linear gradient clamps to its end colour outside its own range, the rect edge
became a hard band of light. The fix each time was to make the fill contain the
whole falloff, or to fill the object's own path instead.

## What is still missing

- **Character animation is still the honest gap.** The actors are procedural
  vector puppets — `makePerson()` in `src/art/paint.js` draws a body from
  canvas paths each frame. This pass gave them directional light (cool moon rim,
  warm bounce off the lamplit planks), gradient shading and trailing cloth, and
  that closes a lot of the distance to the painted backdrop. It does not close
  all of it, and nothing on the tool list will: mesh generators do not make
  charming cel animation. The realistic routes are skeletal 2D (Spine) or 3D
  actors under a toon shader, and both are a different project.
- **Text.** Diffusion cannot hold lettering. "THE BILGE" has come back as
  "Jeavern" and "TÉRA"; the sign currently says TAVERN by luck. Any text a
  player must read should be drawn by the engine over the art.
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
