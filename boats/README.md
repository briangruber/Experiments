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

0. **Start on the dock.** You begin as a person standing on the pier of Port
   Kelder, not as a boat. The lagoon here is shallow and clear — you can see the
   sand, the reef, and the fish moving over it. Fish off the end of the pier
   until you can afford to leave.
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

## Fishing

The calm half of the game, and the way you buy your first real boat. Three
skills, in order:

**Place the cast.** Hold the throw button to wind up, release to cast. Land it
in water deep enough to hold fish — a float on the sand catches nothing.

**Read the take.** The float twitches before it goes under. Those are nibbles;
strike on one and you spook the fish. The real take is unmistakable and you have
about six-tenths of a second to answer it. In clear water you can watch the
shape come up to the bait, which is most of the fun of fishing the lagoon.

**Play the fish.** Holding the reel gains line but loads the rod. The fish runs
in bursts — telegraphed about half a second early, if you are watching — and the
line parts at full tension. Reeling with the tension *high* gains line nearly
twice as fast, so the skilful play is to sit just under the limit and let go the
instant it bolts. It rhymes with the harpoon deliberately: same two gauges, same
question of how hard you dare pull.

Ten species across three depths, from the Silver Sprat off the dock to the
Oarfish, which sailors take as a warning. Bigger fish are rarer, fight harder,
and are worth more per kilo. Fish ride in a basket, not the hold, so a full
catch never costs you monster space.

Press `F` on the boat to get the rod out (you have to be nearly stopped), or
just walk to the end of the pier.

## Controls

| | |
|---|---|
| `W` `A` `S` `D` | walk, ashore — throttle and rudder, afloat |
| `E` | board your boat, step ashore, or open the market |
| `F` | rod out / stowed, on the boat |
| `A` `D` | rudder |
| mouse | look and aim — the reticle is the harpoon |
| click / `Space` | hold to charge, release — harpoon, or cast |
| `R` / right-click | winch the rope, or reel the line |
| `C` | cut the rope / reel in |
| `Tab` | who else is at sea |
| `T` | talk |

### On a phone

The touch build is not the desktop build with bigger buttons — the input problem
is different, so the answers are:

- **Left thumb, anywhere on the left of the screen**, is the helm. The stick is
  drawn where your thumb lands rather than in a fixed corner you have to find.
- **Right thumb** gets THROW (hold to charge, release), WINCH and CUT, sized and
  placed for a thumb arc, plus a **Dock** button that appears in the harbour.
- **The harpoon locks on.** You cannot place a crosshair and steer at the same
  time, so on touch the throw auto-aims at whatever is roughly in front of you
  and solves the drop for you. Point the boat, press THROW.
- **The camera drives itself.** Let go and it eases back behind the bow, so
  nobody has to spend a thumb on the camera. Drag the right of the screen if you
  want to look around anyway.
- The HUD reflows: the chart moves to the top corner and the panels shrink, so
  both bottom corners belong to your thumbs. Safe areas are respected, and
  pinch-zoom, double-tap zoom and pull-to-refresh are disabled over the canvas.

Quality is chosen from the device and then corrected continuously from measured
frame time — render resolution scales between 55% and 100% to hold the frame
rate, and the wave mesh, particle budget, wake length and monster draw distance
all step down on low-end hardware. Force a tier with `?quality=low|medium|high`
if you want to see the difference.

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

## The water

Depth is the game's mood ring, and it is one shared function
(`shared/seabed.js`) read by the floor mesh, the water shader and the fishing.

- **The lagoon** (out to ~230 m): sand, reef and coral under four metres of
  gin-clear water. The reef shelters it, so the swell here is a sixth of what it
  is outside — the harbour is visibly calm.
- **The reef and the brink** (~300 m): the bottom falls away from two metres to
  twenty in the space of a boat length.
- **Past that**: absorption climbs, the floor stops coming back, and you are
  looking at a surface rather than through it.

Monsters know this too. Far from town they lurk *below* — a slow dark shape
under the water and nothing else — and only rise when something takes their
interest, which is usually you. The moment one breaks the surface it takes the
sea with it.

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

## How to actually play it

**Just want to try it?** Build the single file and open it — no server, no
install, works from a phone's browser or straight off disk:

```
node tools/bundle.mjs          # → dist/harpoon-and-hold.html
```

That one file contains the game, three.js and the world simulation. It plays
solo: `shared/sim.js` is transport-free, so the same server code that runs
behind a WebSocket runs inside the page instead. You can email it, drop it on
any static host, or open it with `file://`.

Everything below is for playing *together*, which does need a server — it ships
with one, and it starts in a single command with nothing to install.

**On your own machine.** `node server.js`, then open `http://localhost:8080`.

**On your phone, and with friends in the room.** Start the server on a laptop
and it prints your LAN address:

```
  You:        http://localhost:8080
  Same wifi:  http://192.168.1.24:8080   <- phones and friends type this
```

Anyone on the same wifi types that into a browser and they are in your sea. No
app, no install. This is the fastest way to try it on a phone.

**With friends who are not in the room.** Two options:

- *Tunnel your laptop*, for an evening: `cloudflared tunnel --url http://localhost:8080`
  (or `ngrok http 8080`) prints a public https URL. Send it to people. It dies
  when you close the laptop.
- *Deploy it*, for something that stays up. A `Dockerfile` and `fly.toml` are
  included: `fly launch --copy-config --now` puts it on a shared-cpu machine for
  a few dollars a month. Render, Railway, a $5 VPS — anything that runs Node 18+
  and allows WebSockets works the same way; the server reads `PORT` from the
  environment.

One caveat if you deploy: run **one** machine, not an autoscaling pool. Players
only meet each other if they land on the same process, and the world lives in
that process's memory.

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
server.js            transport only: static files + websockets + a 20 Hz tick
lib/ws.js            RFC 6455 server, ~200 lines, no dependencies
shared/sim.js        the game: spawning, monster AI, damage, gold, sinking
shared/config.js     boats, monsters, prices, XP — imported by BOTH sides
shared/waves.js      the wave field, and the GLSL generated from it
public/src/
  main.js            wiring, boat physics, the game loop
  quality.js         device tier + adaptive render resolution
  sea.js             ocean shader, sky, fog, the edge of the world
  boat.js            all seven hulls, lofted from one section sweep
  monster.js         three body plans: serpent, kraken, leviathan
  harpoon.js         projectiles, rope meshes, tether state
  town.js            Port Kelder
  fx.js              pooled particles, wake ribbons
  solo.js            runs shared/sim.js in the page when there is no server
  hud.js  minimap.js  input.js  net.js  audio.js
Dockerfile, fly.toml  one-command deploy for playing with people elsewhere
```

Three details worth knowing if you change things:

**One wave table.** `shared/waves.js` holds the Gerstner parameters, a CPU
sampler, and a function that emits the equivalent GLSL. The ocean shader is
built from that emitted code, so the water you see and the water your hull bobs
on cannot drift apart.

**One economy.** `shared/config.js` is served to the browser and imported by the
server. The price in the shipwright's window is the price the server charges,
because it is the same number.

**One simulation.** `shared/sim.js` never mentions a socket — it talks to
players through objects with a `send()` method. `server.js` hands it WebSocket
connections; `public/src/solo.js` hands it a two-line fake one and runs the
identical world inside the browser tab. Solo play is not a reduced mode, it is
the same game with one player in it.

## Tools

```
node tools/smoke.mjs --shot shots/a.png    # two headless players, fails on any client error
node tools/protocol-test.mjs               # end-to-end wire test: hit → kill → sell → buy
node tools/bestiary.mjs --out shots/b.png  # every monster in a line on the real ocean
node tools/bestiary.mjs --boats            # every hull, for judging the upgrade ramp
node tools/bestiary.mjs --only frost       # one model, close up
node tools/mobile-check.mjs --shots shots/mobile   # emulated phones, thumbs only
node tools/bundle.mjs --check              # one self-contained .html, no external refs
```

`mobile-check` is the one that earns its keep: it runs the game in an emulated
iPhone SE, Pixel 5 and iPad Mini with real touch events, drives it with the
floating stick and the THROW button, and fails if a control does not move the
boat or if any HUD element lands under a thumb or off the edge of the screen.

The bestiary tool is how the models were iterated on — it drops the given
monsters in front of your own boat so you can judge scale against something
familiar, rather than playing to level 22 to find out the leviathan is too small.
