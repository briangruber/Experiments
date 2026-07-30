# 💣 BOMB BLOBS

**Pass the bomb. Don't be holding it.**

A real-time multiplayer party game that runs in any browser. No install, no
account, no build step — you send a link, your friends click it, and within
three seconds everyone is shoving each other off a shrinking disc while a live
bomb changes hands.

```
npm install
npm start          # → http://localhost:3000
```

Open that URL, hit **PLAY**, and send the room link to anyone else.

---

## The game

Everyone is a blob on a floating arena. One blob is holding a lit bomb.

- **Touch someone** to hand them the bomb. You can't immediately give it back —
  there is a short lock right after you receive it, which is where the panic
  lives.
- **When the fuse runs out**, whoever is holding the bomb pops and is out.
- **You can also die by falling off.** You can't *walk* off the edge — the rim
  acts as a bumper. You only go over if someone shoves you hard, a blast throws
  you, or you dash off it yourself.
- **The floor shrinks** after twelve seconds, so nobody gets to hide on the rim.
- **Last blob standing wins the round.** The next one starts automatically, and
  wins stack up on the scoreboard.

Pickups spawn during a round: **⚡ speed** for a few seconds of extra thrust, and
**🛡 shield**, which lets you survive one explosion — including the one you're
holding. A shield save is the single best comeback in the game.

### Dying isn't the end

Get eliminated and you come back immediately as a **ghost** hovering just outside
the rim. Steer around the ring and press dash to launch a **spook** — a slow,
dodgeable orb that shoves whoever it hits. It hits hard enough to knock someone
into the void, so the blob you just eliminated can absolutely take you with them.

Nobody sits and watches. That's the whole point: a party game where death means
twenty seconds of staring is a party game people quit.

### Every round is different

One modifier is drawn per round and announced during the countdown. Round one is
always plain, so nobody's first impression is a gimmick, and the same one never
comes up twice in a row.

| | |
|---|---|
| **CLASSIC** | Straight up. |
| **BUTTERED FLOOR** | Drag is halved. Nobody can stop. |
| **SHORT FUSE** | Half the thinking time. |
| **CROWDED HOUSE** | The floor starts at two-thirds size. |
| **DOUBLE TROUBLE** | Two bombs at once. |
| **SUGAR RUSH** | Everything accelerates, dash barely cools down. |

When two blobs are left it goes to **sudden death**: the floor starts collapsing
fast and fuses get shorter, so the endgame can't stall into two people politely
circling each other.

### Controls

| | |
|---|---|
| Move | `WASD` / arrow keys, or the on-screen stick |
| Dash | `Space`, or the DASH button |
| Emotes | `1` `2` `3` `4`, or tap them |

Dash is the whole skill ceiling. It has a 1.6s cooldown, and while you're
dashing you count as ~2.5× heavier in a collision — so it's simultaneously how
you catch someone to pass the bomb, how you launch someone into the void, and
how you accidentally launch *yourself* into the void.

### Playing alone

Hit **Add a bot** in the lobby. The bots hunt you when they're holding the bomb,
run when they aren't, grab pickups, and are careful near the edge. Stack up
three or four for a proper melee. The match auto-starts five seconds after there
are at least two blobs, and that timer resets every time someone joins — so
there's always room for one more bot or one more friend.

---

## How it's built

No framework, no bundler, no assets. Three files do the work.

| Path | What it is |
|---|---|
| `server/game.js` | The simulation. Physics, bomb rules, bots, snapshot encoding. |
| `server/index.js` | Static file serving, websocket transport, room routing, the 60 Hz loop. |
| `public/game.js` | Rendering, interpolation, prediction, input, sound. |

**The server is authoritative.** Clients only ever send an intent vector
(`{x, y, dash}`); every position, collision and elimination is decided
server-side, so a modified client can't teleport, phase through people, or
refuse to hold the bomb.

**The simulation runs at 60 Hz and broadcasts at 30 Hz.** Clients render 90 ms in
the past and interpolate between the two snapshots that straddle that moment,
which is what makes other players move smoothly instead of stuttering between
network updates.

**Your own blob is predicted locally.** It runs the same integrator as the
server against your live input and is pulled back toward the authoritative
position every frame, so your keypresses feel instant instead of costing a round
trip. Divergence beyond 80 units snaps rather than drifting.

Snapshots are packed as flat arrays with a bitfield for state
(`alive | bomb | dashing | shield | boost | falling`) — a 12-player room is a
couple of KB per second.

Sound is synthesised in the browser with the Web Audio API — the fuse tick,
the explosion, the pass, the win jingle. There are no audio files to load.

---

## Deploying it

It's a single Node process that serves its own static files, so anywhere that
runs Node and allows websockets works. It listens on `$PORT`.

```
docker build -t bomb-blobs .
docker run -p 3000:3000 bomb-blobs
```

Render, Railway, Fly.io and Cloud Run all take this Dockerfile as-is. `/healthz`
returns room and player counts for health checks.

State is entirely in memory and rooms are reclaimed a minute after the last
human leaves, so there's no database to run. The flip side is that it's a single
process — one instance holds all the rooms, and restarting drops in-flight
matches. Scaling past one box would mean pinning a room code to an instance.

---

## Playing without a server

```
npm run build:solo   # → dist/solo.html
```

Produces one self-contained HTML file you can open straight off disk (or drop on
any static host) and play against bots. It isn't a second implementation of the
game — the build inlines `server/game.js` and `public/game.js` verbatim and slots
a fake WebSocket between them, so the real simulation runs in a timer in the same
tab and feeds the real client the exact `meta` and `s` messages the real server
would have sent. One source of truth for physics, so it can't drift.

Useful for trying the feel, tuning constants, or handing someone the game when
you don't have anywhere to deploy it.

## Tests

```
npm test            # both suites
npm run test:rules  # rules only, ~1s
npm run test:e2e    # the networked one
```

`test/sim.js` drives the `Room` directly with no server and no sockets, asserting
the rules themselves: fuses detonate, a pass carries the *remaining* time rather
than resetting it, a shield eats your own explosion, elimination produces a
ghost, a spook connects and shoves hard enough to ring someone out, walking pace
can't take you off the edge but being thrown can, sudden death triggers on the
last two, and modifiers apply and never repeat back to back.

`test/smoke.js` boots the real server, joins with two real websocket clients,
adds bots, mashes inputs, and asserts a whole round plays out over the wire.

The split matters: the end-to-end test waits on emergent behaviour, so anything
asserted purely there gets flaky the moment balance changes. Rules belong in the
deterministic suite.

---

MIT.
