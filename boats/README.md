# Harpoon & Hold

A multiplayer sea-monster hunting game. You start with a rowboat, two crew and no
money. Somewhere out there is a thing the size of a warehouse, and the only way
to get a bigger boat is to put a rope in it and drag it home.

```
cd boats
node server.js          # → http://localhost:8080
```

No install step, no build step, no dependencies. Three.js is vendored in
`public/vendor/`, the server is plain Node (including its own RFC 6455
WebSocket implementation), and everything else is hand-rolled.

Open the URL in two tabs — or on two machines pointed at the same host — and
you are hunting together.

## The loop

1. **Sail out.** The further from Port Kelder you go, the bigger what lives
   there. The minimap's rings are the actual spawn bands from the config, so it
   doubles as a difficulty map.
2. **Throw.** Hold click (or space) to wind up, release to throw. A full-power
   throw flies flat and hits harder; a tap lobs.
3. **Hold on.** The harpoon tethers you to something that does not want to be
   tethered. It runs, and it drags your boat with it — a small boat on a big
   monster is a Nantucket sleigh ride. Watch the rope strain: winching adds
   strain, an over-extended rope adds strain, and at 100 the rope parts and you
   have lost the harpoon and made something angry.
4. **Winch.** Hold `R` (or right-click) to crank. Crew turn the winch — the more
   of them the monster has eaten, the slower you reel.
5. **Sell.** Kill it and the carcass goes in your hold, towed astern on a line.
   Sail home and sell it at the fish market.
6. **Upgrade.** Gold buys a bigger hull, which survives further out, which is
   where the bigger monsters are.

If your hull reaches zero you sink: you lose the ship, everything in the hold,
and 40% of your purse to the crew's families. You wake up in a rowboat. The
monster is still out there.

## Controls

| | |
|---|---|
| `W` `S` | throttle / reverse |
| `A` `D` | rudder |
| mouse | look and aim — the reticle is the harpoon |
| click / `Space` | hold to charge, release to throw |
| `R` / right-click | winch the rope in |
| `C` | cut the rope |
| `E` | dock (inside the harbour) |
| `Tab` | who else is at sea |
| `T` | talk |

Touch devices get a stick, a throw button, a winch button and a cut button; drag
anywhere to look.

## The fleet

| Hull | Price | Level | Hull pts | Crew | Harpoon | Rope | Hold |
|---|---|---|---|---|---|---|---|
| Rowboat | — | 1 | 60 | 2 | 12 | 46 m | 1 |
| Skiff | 240 | 2 | 145 | 3 | 22 | 72 m | 2 |
| Cutter | 880 | 4 | 300 | 5 | 38 | 108 m | 3 |
| Whaler | 2,600 | 7 | 560 | 8 | 62 | 155 m | 4 |
| Brigantine | 7,200 | 11 | 980 | 12 | 98 | 215 m | 5 |
| Galleon | 19,000 | 16 | 1,650 | 18 | 152 | 290 m | 6 |
| Leviathan-Class | 46,000 | 22 | 2,600 | 26 | 225 | 380 m | 8 |

Trading up credits 30% of your current hull.

## The bestiary

| Monster | Found | HP | Bounty | Notes |
|---|---|---|---|---|
| Silverfin Serpent | 240–700 m | 95 | 95 | Everyone's first kill |
| Gulper Eel | 420–1150 m | 240 | 300 | Faster, bites more often |
| Reef Kraken | 700–1600 m | 560 | 860 | Arms rear out of the water |
| Ironback Whale | 1050–2100 m | 1,250 | 2,250 | Rams. Takes two hold slots |
| Abyss Kraken | 1450–2600 m | 2,600 | 5,400 | Eats crew two at a time |
| Frost Leviathan | 1900–3000 m | 5,200 | 12,500 | Bigger than a brigantine |
| Maelstrom Wyrm | 2400 m+ | 12,000 | 31,000 | Bring friends |

## Multiplayer

Everyone shares one sea. Monsters, gold, levels and the consequences of sinking
are the server's business; your own boat's motion is simulated locally, because
this is a co-op hunting game and a 60 Hz hull that argues with the server feels
worse than one that does not.

Put ropes in the same monster and the kill is shared: every crew that did damage
gets paid a share in gold immediately, and whoever did the most takes the
carcass — which is only worth full price at the dock. So the incentive is to
help, and then to race home.

Progress is keyed to a token in `localStorage`, so a refresh puts you back in
your own boat rather than a fresh rowboat. Progress lives in server memory and
is dropped 12 hours after you disconnect (and on restart) — this is a game to
play in an evening, not a database.

## Layout

```
server.js            HTTP + game loop: spawning, monster AI, damage, economy
lib/ws.js            RFC 6455 server, ~200 lines, no dependencies
shared/config.js     boats, monsters, prices, XP — imported by BOTH sides
shared/waves.js      the wave field, and the GLSL generated from it
public/src/
  main.js            wiring, boat physics, the game loop
  sea.js             ocean shader, sky, fog, the edge of the world
  boat.js            all seven hulls, lofted from one section sweep
  monster.js         three body plans: serpent, kraken, leviathan
  harpoon.js         projectiles, rope meshes, tether state
  town.js            Port Kelder
  fx.js              pooled particles, wake ribbons
  hud.js  minimap.js  input.js  net.js  audio.js
```

Two details worth knowing if you change things:

**One wave table.** `shared/waves.js` holds the Gerstner parameters, a CPU
sampler, and a function that emits the equivalent GLSL. The ocean shader is
built from that emitted code, so the water you see and the water your hull bobs
on cannot drift apart.

**One economy.** `shared/config.js` is served to the browser and imported by the
server. The price in the shipwright's window is the price the server charges,
because it is the same number.

## Tools

```
node tools/smoke.mjs --shot shots/a.png    # two headless players, fails on any client error
node tools/protocol-test.mjs               # end-to-end wire test: hit → kill → sell → buy
node tools/bestiary.mjs --out shots/b.png  # every monster in a line on the real ocean
node tools/bestiary.mjs --boats            # every hull, for judging the upgrade ramp
node tools/bestiary.mjs --only frost       # one model, close up
```

The bestiary tool is how the models were iterated on — it drops the given
monsters in front of your own boat so you can judge scale against something
familiar, rather than playing to level 22 to find out the leviathan is too small.
