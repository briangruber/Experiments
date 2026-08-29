# Experiments — agent routing

**File-only unless asked.** Do not load, preview, or run a prototype to
look at it (no browser MCP, no headed Chromium, no screenshot loops).
The user is the eyes. Open a live page only when they explicitly ask.

**Do not run the check suite during look-and-feel work.** When the user is
iterating visually, running `check-*.mjs` burns their CPU and their time for
a verdict they are about to give you themselves. Make the change, say what to
look for, and stop. Run checks when you have changed behaviour they cannot
see, or when they ask.

One folder per prototype, nothing at the root (see [README.md](README.md) for
why). Work inside the folder your task names; never move a prototype's files
into the root or into `tools/` of another prototype.

| task mentions | go to |
| --- | --- |
| ocean, water, sea, waves, sky, clouds, Abyssal, `abyssal-ocean`, WebGPU/TSL port | [`ocean/`](ocean/) — read [`ocean/AGENTS.md`](ocean/AGENTS.md) first |
| adventure game, point-and-click, Monkey Island, verb coin, walk boxes, puzzle graph, dialogue tree, backdrop plate, Grout, the Errant Kipper | [`monkey/`](monkey/) — read [`monkey/README.md`](monkey/README.md) first |

Other prototypes (`harbor/`, `boats/`, `cozy-fishing/`) live on their own
branches under the same convention.
