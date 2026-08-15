# Studio — a production tool for AI-shot film and television

## Context

`telenovela/film/` proved that a scene can be covered as separate AI-generated
shots and cut together without the joins showing. Three shots, two hard cuts,
consistent characters, wardrobe, room, lighting, voices and a bed running
straight through the edit.

It proved it for exactly one scene, hardcoded. `scenes/s01-testamento/scene.js`
is a single file that describes a style, two characters, one room and three
shots, and every tool imports it by name. Nothing about it is reusable for a
second scene, let alone a second show.

The goal is a product that produces that result for any show, repeatedly, with
a UI for building the cast and describing changes to them. The mechanism is
already understood — this is a data-model and workflow problem, not a
generation problem.

### The invariant everything follows from

The endpoint has **no seed**. A take cannot be reproduced. So consistency is
only ever the product of three things: identical words, identical reference
assets, and reference discipline. Every design decision below is downstream of
that, and two of them are counter-intuitive:

- **Nothing regenerates silently.** A normal build system rebuilds when inputs
  change. Here a rebuild destroys an approved artefact that cannot be got back.
  Staleness is detected and *reported*; regeneration is always a human act.
- **Everything is a take.** You roll several and pick one, which is how film
  has always worked. Selection is a first-class operation, not a retry.

## What has to be pulled apart

`scene.js` conflates four scopes that need separate lifetimes:

| scope | lives for | holds |
| --- | --- | --- |
| **Production** | the whole show | style, look/grade, aspect, resolution, audio rules |
| **Company** | many episodes | characters: identity, wardrobe looks, voice |
| **Locations** | many scenes | sets, each with lighting states |
| **Scene** | itself | cast + looks, blocking, the 180° line, shots, dialogue |

Two axes are new and are the substance of the ask:

- **Wardrobe.** A character is not one sheet — it is identity × look. A scene
  declares `{character, look}`. Voice belongs to the character; the sheet
  belongs to the look.
- **Lighting state.** A location is geography × state. The same dining room at
  night in a storm and at morning is one location, two plates.

**Wardrobe looks must be derived by editing the approved sheet, never generated
fresh.** A fresh generation from a new description re-rolls the face and you
get a different actor in a different dress. This is the single most important
rule in the asset model, and it is the same mechanism as "describe an edit to
this character" — one primitive serves both.

## Data model

Plain JSON and files on disk. Git-friendly, diffable, inspectable, no database.

```
studio/projects/<show>/
  show.json                     style, look, audio rules, aspect, resolution
  company/<character>/
    character.json              identity, voice direction, sample line
    voice/plate.mp4 voice.mp3   the cast voice + its provenance
    looks/<look>/
      look.json                 wardrobe description, derived-from
      sheet.png                 the selected sheet
      takes/<n>.png + .json     candidates, with the edit instruction that made each
  locations/<location>/
    location.json
    states/<state>/plate.png + takes/
  episodes/<ep>/scenes/<scene>/
    scene.json                  cast+looks, location+state, line rule, shots[]
    shots/<shot>/takes/<n>.mp4 + .json, selected
    dist/                       scene.mp4, bed.mp3, subtitles
```

Every generated file carries a sidecar with the prompt, inputs, and a hash of
the inputs that produced it — the provenance pattern already used by
`telenovela/film/shots/*.json`, and by the existing engine's `.mp3.hash`
sidecars in `telenovela/episodes/e01-corazon/voice/`.

## Reuse

Almost every generation step exists and works. The build is mostly extracting
these from their hardcoded scene import into a library:

| existing | becomes |
| --- | --- |
| `film/tools/fal.mjs` | `lib/fal.mjs` — unchanged, already generic |
| `film/tools/refs.mjs` | `lib/images.mjs` — + an `edit` path for wardrobe/notes |
| `film/tools/voices.mjs` | `lib/voice.mjs` |
| `film/tools/shoot.mjs` | `lib/shoot.mjs` — keep the upload ledger and sidecars |
| `film/tools/cut.mjs` | `lib/cut.mjs` — the ffmpeg graph is already general |
| `film/tools/subs.mjs` + `speech.py` | `lib/subs.mjs` — unchanged logic |
| `film/tools/voicecheck.py` | `lib/continuity/` — one of several checks |
| `film/tools/score.mjs` | `lib/score.mjs` |
| `scenes/s01-testamento/scene.js` | the prompt builder, driven from JSON |

The `buildPrompt` discipline is the thing to preserve exactly: the spine is
assembled by one function so it is *provably* identical between shots, never
retyped. In the product this becomes `lib/prompt.mjs`, composing show + scene +
shot into the same clause order that works today.

## Server and UI

Node HTTP server, vanilla JS front end, no build step — matching the rest of
the repo. Assets served from the project directory. Jobs are long (3–5 min a
shot), so generation runs through a queue with **SSE** for live progress.

Shooting a scene is serial by nature — a shot may chain the one before it —
but company assets parallelise freely.

Five views:

1. **Company** — character grid. Open one: sheet, wardrobe looks as tabs, voice
   plate with a play control. A single prompt box, *"describe a change"*,
   produces candidate takes shown against the current one; approve or discard.
   Adding a look is the same box with different framing.
2. **Locations** — the same shape, lighting states instead of looks.
3. **Script** — scenes. Write the scene in prose, pick location + state, cast
   characters with their look and their side of frame. A model drafts the
   coverage — shot sizes, angles, who faces which way, where the lines fall —
   and every field is editable before anything is generated. The 180° rule is
   derived from the cast blocking rather than typed.
4. **Shoot** — cost estimate first, then the queue: progress, logs, and a takes
   gallery per shot. Roll more takes; pick the keeper. A 480p blocking pass,
   then promote approved shots to 720p.
5. **Cut** — the selected takes on a timeline with trim marks, the bed,
   subtitles, the continuity report, and export.

## Continuity report

Objective, cheap, and built on what already exists:

- **Voice drift** — median f0 per character per shot against their voice plate
  (`voicecheck.py` already does this; it caught Perpetua's 7% drop).
- **Grade drift** — colour histogram and mean luma distance between adjacent
  shots, via ffmpeg `signalstats`.
- **Speech timing** — lines running to the final frame, leaving no handle
  (`speech.py` already measures this).

Reported as **advisory, never blocking**. A wide and a close-up legitimately
differ in luma; the report flags outliers for a human, it does not gate.

## Build order

1. **Extract the library.** Move the film tools to `studio/lib/`, parameterised
   by a project object instead of importing a scene. No behaviour change.
2. **Import El Testamento** as `projects/telenovela/` in the new schema. This
   is the correctness test: the same three shots must cut to the same result
   through the new code path, regenerating nothing.
3. **Server + job queue + SSE.** Read-only UI first: browse the imported show.
4. **Company view** with take selection and the describe-an-edit loop, then
   wardrobe looks as edits.
5. **Locations**, same machinery.
6. **Script view** with AI-drafted coverage.
7. **Shoot view** — queue, cost estimate, 480p pass, takes gallery.
8. **Cut view** — marks, bed, subtitles, continuity report, export.

Each phase ends somewhere usable; nothing is left half-migrated.

## Image editing — verified, and model-agnostic

Editing runs on fal, not the Vercel gateway, and the model is a **user choice**
rather than a hardcoded decision. `lib/edit.mjs` keeps a small registry of
endpoints; the UI shows the list with live prices and remembers the pick per
project.

**Prices are never hardcoded.** `https://fal.ai/api/models?query=<term>` returns
a `pricingInfoOverride` string per model, maintained by fal. The app fetches
and caches it, so the number on screen is the real one even when fal changes
it. Same mechanism can price the video endpoint.

Shortlist as of today, with fal's own figures:

| endpoint | lab | price |
| --- | --- | --- |
| `fal-ai/nano-banana-2/edit` | Google | $0.08/image (2K ×1.5, 4K ×2) — **default** |
| `bytedance/seedream/v5/pro/edit` | Bytedance | ~$0.0675 + $0.0045/extra input |
| `fal-ai/flux-2-pro/edit` | Black Forest Labs | $0.03 first MP + $0.015/extra MP |
| `fal-ai/nano-banana-pro/edit` | Google | $0.15/image |
| `xai/grok-imagine-image/edit` | xAI | $0.022/image |
| `openai/gpt-image-2/edit` | OpenAI | token-priced |

nano-banana-2 is the default on quality for the money. Seedream v5 Pro is worth
offering prominently despite being newer and less proven: it is from the same
lab as Seedance 2.5, so its output may sit more naturally with the video model.

**Verified end to end.** Rosalinda's approved sheet was edited to a black
mourning gown with the locket removed: identity, comb, eyes, plumage, feet, all
three views and the grey backdrop survived intact. Two things learned that go
straight into the implementation:

- **Pin `aspect_ratio` to the source sheet.** Left on `auto` the edit came back
  2528×1686 against a 1536×1024 original. Harmless once, corrosive over a chain
  of edits.
- **Image endpoints take a `seed`; the video endpoint does not.** So sheets and
  plates *are* reproducible and video takes are not. The staleness rule can
  therefore be softer for images (offer to regenerate, seed recorded) and must
  stay absolute for shots (never regenerate, ever).

### The wardrobe rule, concretely

A character has one **default look**, generated from scratch. Every other look
is produced by handing the editing model the *approved default sheet* plus an
instruction naming only the garment change, with an explicit "keep the
character unchanged" clause listing face, plumage, proportions, views, pose,
backdrop and lighting. The resulting sheet is what gets passed to Seedance as
`@ImageN` for any shot in that wardrobe.

Looks therefore form a tree rooted at the default, and `look.json` records what
it was derived from and by what instruction. Re-deriving a look after the
default changes is one click, and never a re-cast.

## Verification

- **Regression:** the imported El Testamento cuts to a 15.8s file with three
  shots, five subtitle cues and a continuous bed, with zero API calls.
- **New character end to end:** create one from a description, take two rolls,
  select, add a second wardrobe look by editing the approved sheet, confirm it
  is recognisably the same character, cast the voice, confirm the plate is
  clean by spectrogram.
- **New scene end to end:** two shots in a new location, blocked from opposite
  sides, shot at 480p, take-selected, cut with a bed and subtitles. The 180°
  line must hold and the subtitles must sit on the mouths.
- **Staleness:** edit a character's description after shooting; confirm the app
  reports every affected shot as stale and regenerates nothing.
- **Cost:** the pre-shoot estimate is within ~10% of what fal actually bills.

## Cost

Unchanged per generation: ~$0.47/s at 720p, ~$0.28/s with a video reference,
~$0.22/s at 480p. The product's job is to keep the count down — cache
aggressively, never regenerate silently, block at 480p, and show the number
before the money is spent.
