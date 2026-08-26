# Halcyon Online

A 1997 computer you can switch on, dial into, and talk to people on.

You land in a dark room with a beige tower. Press the power button and it
POSTs, counts its memory, and boots **Panes 95**. On the desktop, among the
other things a machine of that vintage had, is **Halcyon Online 3.0**.
Double-click it, sign on with any name, and listen to the whole modem
handshake — off-hook click, dial tone, touch tones, ring, answer tone, the
warble, four bongs, the descending hiss — before the room opens.

Halcyon is invented. It is not any service that existed.

## What it is copying, and from what

Built against screenshots of the real thing rather than from memory, and
the palette is sampled off them rather than guessed. Two eras are mixed
deliberately, because the machine is a 1997 one running a 3.0-numbered
client with the 4.x look people actually picture:

- **one application frame**, and everything else — Welcome, chat rooms,
  mail, channels, buddy list, instant messages — is an MDI child inside
  it, never a window on the desktop
- **title bars that run blue → purple → red** across their width
  (`#1b3ca3 → #6f176e → #cc2b23`, sampled), with a **heart** at the
  right-hand end for filing the window in Favorite Places
- a short menu bar: **File / Edit / Window / Sign Off / Help**
- a **deep blue toolbar** of large colour icons with light labels beneath,
  in three groups, several carrying a drop-down caret; the badge sits on
  its own blue panel at the right-hand end
- beneath it a **cream keyword bar**: Main Menu, then the keyword box and
  its `Go` and `Keyword List` buttons
- **window faces in warm cream** (`#dcdccf`), not system grey, and blue
  bevelled buttons instead of the Win95 ones
- **Channels** as a rail — badge, heading, "Return to Welcome", a blue
  oval `Find` — beside a grid of colour banner buttons, each with its own
  palette and type treatment, because that variety was the whole look
- the **Keyword window**: badge, a big heading, one field, and two blue
  buttons, `Go` and `Keyword List`

An earlier pass followed 2.x/3.0 screenshots, which is where the Go To
menu's accelerators came from: Keyword was Ctrl+K, the Lobby Ctrl+L,
Favorite Places Ctrl+B, the Main Menu Ctrl+D. Those still work.

What is *not* copied is the branding. The name, the wordmark, the diamond
badge and every icon here are ours. The typographic idiom — a geometric
badge over letterspaced caps with "Online" in a script face — was common
to the whole era.



## The keyword era, on purpose

There is no address box and no way to type a URL anywhere in Halcyon. The
service is a walled garden you move around with keywords — press Ctrl+K,
type `TRIVIA`, and you are in the room. `Find Central` searches the
service, not the world, and says so.

The machine does have a browser. It is NetScrape, it is on the desktop and
in the Start menu, and it is a separate program — which is exactly where it
belonged before the two got merged.

## The Reverie Network

Keyword `REVERIE`, or the icon on the desktop. The other kind of service
the era had: not a wall of text but a painted world you walked around as a
face you built yourself, with board games in it.

It is drawn in that kind of service's grammar rather than Halcyon's:
saturated flat grounds, three-pixel bevels on everything, red serif
headings, and portraits hung in mounted frames with a yellow name plate
under the chin. The text services looked like software; the graphical ones
looked like a boxed game, and the difference was the whole point.

- **Make a face.** Two flanking columns of arrow buttons — skin, hair
  style, hair colour, eyes, eyebrows down one side; nose, mouth, hats and
  glasses, clothes and backdrop down the other — with the sitter between
  them. Head *and shoulders*, on a wash, because these were portraits and
  not floating heads. Drawn as vectors, so a face is ten small numbers and
  every combination is instant. Yours is remembered; everybody else's is
  derived from their screen name, so the same person always looks the same.
- **The island.** A painted town in a mount with a numbered blue badge on
  each of seven places, and the same numbers again in a cream legend down
  the right-hand side. Each badge says how many people are standing there.
  They are populated before you arrive — a map of empty rooms is worse
  than no map.
- **The town moves.** Water comes out of both fountains, smoke off a
  chimney, gulls across the top, a pennant on the castle tower that never
  quite settles, and a light on the big wheel that catches every few
  seconds. It is a layer of small CSS sprites laid over the painting at
  measured positions — no canvas, no timers, nothing on the critical path
  — and all of it stops dead under `prefers-reduced-motion`. The badges
  and the legend arrive one after another rather than all at once, which
  is the difference between a screen that loads and a screen that opens.
- **Stand somewhere.** The four lands are painted backdrops with the crowd
  in a row of framed portraits along the bottom edge, name plates under
  them, speech bubbles over whoever just spoke. A green tab marks anybody
  who is really another person.

Seven places, and six things to do in them. Each game wears the same suit:
a title strip, a painted banner, a framed playing area, the players' faces
with plates down the side, and a button bar along the bottom.

- **The Fountain — a wish.** Throw a coin in and leave one phrase from the
  book. The wishes already in the water are the town's own; yours is kept
  on this computer and sent nowhere.
- **The Post Office — the postcard board.** The same thing pinned up
  slightly crooked, with pigeonholes and parcel string behind it.
- **The Bridge Inn — Shut the Box.** Nine flaps, two dice, and the
  question of how to spend a seven. Once everything left is six or under
  the house lets you roll one die. Shut all nine and you have shut the
  box, which most people never do.
- **Jouster's Keep — Checkers.** Compulsory captures, multi-jumps, kings,
  and an opponent that searches two plies and will beat you if you are
  careless.
- **The Boardwalk — Crazy Golf.** Six holes and the four hazards a
  seaside course actually had: painted rails, a pond that costs you a
  penalty stroke and puts you back where you were, a bunker that eats
  your pace, bumpers robbed off a pinball table, and a windmill on the
  last because there is always a windmill on the last. Drag back from the
  ball to putt: the line you will leave on is drawn with an arrowhead, and
  a power meter says how hard, which is the one thing these games never
  told you and always should have. Full card, par, and a running total.
- **The Boardwalk — The Machine.** A slot machine in a red cabinet with a
  marquee and a pay table. Tokens are not money, cannot be bought, and top
  themselves up when you run out.
- **Sky Squadron — Dawn Patrol.** A biplane dogfight over a parallax
  ridge, a hangar and a windsock. Up and Down fly, Left and Right work the
  throttle, space fires. Thrust along the nose, gravity, drag, lift
  proportional to airspeed, and a stall if you let the speed go — so
  climbing costs you something and the ground is genuinely dangerous.
  Instruments for airspeed, altitude and throttle, with the stalling speed
  marked on the dial where it belongs. A holed engine will not make full
  power and trails smoke, then fire. The other aeroplane flies the same
  physics, works its own throttle, and is trying to get behind you.
- **Cloud Nine** has no game at all, on purpose: one place that is only
  for standing about and talking.

The same phrase book governs the lands as governs the chat rooms.

## The Midnight Carnival BBS

`Telepath 2.6` on the desktop: a comms program with a dialling directory,
which is how you got out of the house before there was a service to join.

Four numbers are in the book and the hit rate is period-accurate — one
answers, one is engaged, one rings out, and one has been disconnected. The
connect speed is a real setting (2400 / 9600 / 14400 / 33600) because the
difference between text arriving at 240 characters a second and at 3,360
is most of the feeling. There is a **Skip the noise** button, because the
handshake is the best part exactly once, and a **Faster** button that lands
whatever is still in flight.

Behind it is one computer in somebody's spare room with two lines into it:
a login, bulletins, three message bases with an argument running through
them, a file area that works out how long a download would take and then
declines on ratio grounds, a who's-online list, and a sysop who does not
answer the page because it is the middle of the night.

Colour is written in **pipe codes** — `|15` white, `|04` red — because that
is genuinely how the sysop of a Renegade or Telegard board wrote their
menus, and because it keeps escape characters out of the source.

Two **doors**, which is what a board called its games:

- **Tale of the Scarlet Wyrm.** A turn-limited fantasy game of the shape
  every board carried one of: a village of single-key destinations, a
  forest that is the only place experience comes from, fifteen fights a
  day, eleven masters who will not teach you until you have earned it, a
  weaponsmith, an armourer, a bank that pays interest overnight, an inn
  where sleeping ends the day, and a dragon on the high fells at the end
  of twelve levels. Die and you lose what you were carrying; the bank keeps
  what it has. It is meant to take a few days. The names, the monsters,
  the masters and every line of the writing are invented — what is borrowed
  is the form, which was common to dozens of these.
- **Sector Run.** Five ports, four cargoes, twenty-five jumps a day. Each
  port makes one thing cheaply and wants another badly, so the route is the
  game. Prices are a function of the port and the day, which means the
  market is the same for every caller on a given day and you can argue
  about it afterwards.

Nobody can post to the message bases and no caller can send another one
anything: the bases are an archive of what was already said, and the only
free text on the whole board is your own handle, which goes through the
same conduct check as a Halcyon screen name. A board with an open text
field and no moderator is exactly the thing this prototype is trying not
to build, so the sysop took node chat out in 1993 and has not missed it.

## The artwork and the voice

Generated with fal.ai and baked into `src/assets/` as data URIs, so the
folder still works with no network and no key:

- **sixteen channel banners.** The subject is generated; the flat colour
  field the label sits on is composed here, so the type always reads. Then
  the whole banner is quantised to 64 colours with Floyd–Steinberg
  dithering, which is what a banner on this service actually was, and
  which makes sixteen separate generations look like one set.
- **the marbled panel** on the sign-on window, and the **welcome banner**
  behind the greeting.
- **Reverie's island town, seven land backdrops and two game banners**,
  painted in the style of a 1990s point-and-click adventure and quantised
  to 32 colours to match. The two game banners had to be prompted with the
  style *before* the subject: asked for "a crazy golf course on a pier"
  first, the model returns a photograph and ignores everything after the
  comma.
- **one animation** — a slow flight over the island, used as the curtain
  at Reverie's gate. Generated as video, cut to sixteen frames at 8 fps
  and packed as a looping animated WebP, which is what an animated GIF on
  a page in 1997 was.
- **the announcer** — "Welcome", "You have mail", "Goodbye" — at 11 kHz
  8-bit mono, which is both what a `.wav` on this machine would have been
  and about a tenth of the bytes. It replaces the browser's speech
  synthesiser, which read them like a railway station.

`node tools/gen-assets.mjs` regenerates them; it needs `FAL_KEY`. The
generated modules are committed, so nobody else needs one. Total cost to
the bundle: about 60 KB of pictures and 105 KB of sound.

## Running it

Serve the folder and open `index.html`. There is no build step.

```
python3 -m http.server 8000        # then open http://localhost:8000/dialup/
```

It needs to be served rather than opened as a `file://` URL, because it is
ES modules. Add `?fast` to the URL to skip most of the POST while you are
working on something further in.

```
npm run check      # static: parses, imports, control characters, CSS classes
npm test           # the above, plus the safety layer and the relay
npm run bundle     # flatten to one self-contained file in dist/
npm run relay      # the optional multi-user relay
```

`npm run bundle` inlines the stylesheets and flattens the module graph into
a single classic script, producing `dist/halcyon.html` with no external
references at all. That file opens straight off disk, so it is the easiest
way to hand the whole thing to somebody.

## What is in here

**Halcyon Online** — a dialer, a sign-on screen, a welcome screen with mail
waiting, chat rooms with people in them, instant messages, a buddy list, a
mailbox, a channel menu, and a keyword box. Keywords: `CHAT` `TRIVIA` `MAIL`
`WEB` `NEWS` `WEATHER` `MONEY` `GAMES` `HOROSCOPE` `BUDDY` `HELP` `TOS`.

**The rooms** are the point. Eight regulars come and go, each with a voice
rather than a script: a set of quirks that turns plain sentences into how
that person typed in 1997 — the shorthand, the doubled punctuation, the one
who never uses the shift key and the one who uses it for everything. They
notice what you say, take a believable amount of time to type back, ask
a/s/l, forward chain letters, and get removed by a Guide for scrolling the
room. The Trivia Tavern has a host who actually runs a quiz; type `SCORE`.

**NetScrape Navigator** and about six hand-made pages: a personal homepage
with frames it apologises for, a very loud fan page, a webring, a search
engine with five documents in its index, and a short note about what is
real here. Hit counters count. Guestbooks remember. Pages load text first
and then let the pictures crawl in.

**Telepath 2.6** — a comms program, four boards in the dialling directory,
and one of them worth calling. See above.

**The rest of the desktop** — Mine Hunt (a real one: first click is always
safe, chording works), Sketchpad, Jukebox 95, Disk Defragmenter that
actually compacts a modelled disk, Notepad, My Computer over a small fake
filesystem, a Recycle Bin with things in it, four screensavers that come on
after ninety seconds, and a paperclip called Kip who would like to help.

Every sound is synthesised — six oscillators and a filter, no samples.

## The multi-user part

There are two transports behind one interface, and the safe one is the
default.

**Local (default).** Other browser tabs on this machine are real other
users, found over `BroadcastChannel`. Open the page in a second tab, sign on
with a different screen name, walk both into the same room, and they will
see each other. Nothing leaves the browser. One tab is elected host — lowest
peer id wins — and runs the room simulation, so every tab sees the same
people saying the same things.

**Relay (opt-in).** For two people at two computers:

```
node tools/relay.mjs                    # 127.0.0.1:8790, this machine only
node tools/relay.mjs --host 0.0.0.0     # your network, with a warning
```

Then tick *Connect through a relay* on the sign-on screen. The relay has no
dependencies — the WebSocket handshake and framing are in the file — binds
to loopback unless told otherwise, keeps nothing on disk, logs no message
contents, replays no history, and forwards only the message shapes the
client speaks, rebuilt field by field rather than passed through. It is a
relay, not a service: no accounts, no server-side moderation, everyone on
the wire sees everything. Do not put it on the public internet.

## How it stays safe

**Nobody can type a sentence at anybody.** You type whatever you like into
the box; what actually travels is the closest phrase from a fixed,
hand-written vocabulary of about two hundred (`src/apps/halcyon/phrasebook.js`,
readable end to end in a minute, and browsable in the app). The box shows
you which phrase it will send before you commit. Your keystrokes are read
by the matcher and thrown away — they never reach another tab, the relay,
or anywhere else.

That is a stronger property than screening free text, because it is
structural rather than a judgement call: the set of sayable things is
finite and is right there in the repository. There is no filter to outwit,
no spelling to work around, no new slur to add to a list next year. It is
also more in period than free text — chat in 1997 ran on stock phrases,
and a menu of them is funnier than most of what people would type.

The rest of `src/core/safety.js` still runs behind it, and still matters:

1. **Shape** — a token bucket, because a finite vocabulary can still be
   used to flood a room. Normal conversation is never throttled.
2. **Privacy** — telephone numbers, addresses, e-mail and card numbers are
   stripped. Unreachable from the phrase book by construction, but the
   relay is defended against a client that is not this one.
3. **Conduct** — whole-word masking, for screen names and for anything
   arriving over the relay.

Then the in-fiction layer: three warnings and a Guide removes you from the
rooms for a minute. Every instant message window has a Notify button, and
it does something. Every chat room has Ignore. The phrase book has a
**Speak Up** category, because a vocabulary that cannot say "please stop"
is not a safe one.

Two beats are deliberately educational. A member called **HaIcyon
Billing** — capital i, not an l — asks for your password by instant
message; a Guide arrives to explain the trick. The same message is in your
mailbox.

## On making it feel busy

The goal was for solo browsing to feel like a place with people in it.
Four layers do that, and it is worth being exact about which are real:

| layer | real? |
| --- | --- |
| The regulars in every room and land | Programs. Eight personas with distinct voices, who arrive, talk, forward chain letters and get told off by Guides. |
| Other tabs on your machine | **Real people.** Found over `BroadcastChannel`; they show a green dot next to their name in Reverie. |
| Other machines on your network | **Real people**, if somebody runs `tools/relay.mjs`. |
| Member numbers and the "1,2xx,xxx members" line | Fiction, and part of the set dressing, like the modem speed. |
| The caller on node 2 of the BBS, and its message bases | Written. Nothing on the board is another person, and nothing you type there leaves your machine. |
| Wishes in the fountain and cards on the postcard board | The ones already there are written. Yours is kept in `localStorage` and sent nowhere. |

There is deliberately **no global live user count**, because there is no
honest way to build one here: a published artifact gets no shared-state
capability, so any number claiming to be "people online right now" would
be a number this page made up. The counts you see — on the island map, in
a room's member list — are the real contents of that room's roster.

The thing that actually sells presence is not a number, it is **faces**.
Eight names in a list is a list; eight faces standing in front of a castle
with speech bubbles over them is a party.


## Layout

```
index.html            the shell: a room, a monitor, a desktop
src/
  main.js             power on, POST, desktop
  core/
    dom.js            h(), drag, small helpers
    audio.js          every sound in the prototype, synthesised
    wm.js             windows, taskbar, dialogs
    net.js            the two transports and the room simulation
    safety.js         the screening pipeline
    icons.js  fs.js
  boot/               BIOS, splash, desktop shell
  apps/
    halcyon/          the service: dialer, chat, IM, mail, channels, people
    reverie/          the painted island: faces, town, lands, six games
    bbs/              Telepath, the Midnight Carnival, and its two doors
    sites/web.js      the World Wide Web, as data
    browser.js  minehunt.js  sketchpad.js  jukebox.js  defrag.js
    notepad.js  mycomputer.js  recycle.js  screensaver.js  assistant.js
  style/              chrome.css (the OS), halcyon.css, reverie.css,
                      bbs.css, web.css
tools/
  check.mjs           static checks, no browser
  test.mjs            safety layer and relay behaviour
  bundle.mjs          flatten to one self-contained HTML file
  relay.mjs           the optional multi-user relay
```

Chat messages are only ever put on screen with `textContent`, and the web
pages are data run through a whitelisting builder, so there is no path from
anything anyone types to markup.

## Things to try

- Type `SCORE` in the Trivia Tavern.
- Ask the room `a/s/l`.
- Double-click somebody's name in a chat room.
- Type a telephone number into a room.
- Read the mail from CoffeeAchiever and download the attachment. It is
  47 kilobytes and it arrives a few scanlines at a time, which is what a
  photograph cost.
- Read the mail from HaIcyon Billing and look closely at the sender.
- Put an address NetScrape has never heard of in the Location box.
- Sign a guestbook, then reload the page.
- Leave the machine alone for ninety seconds.
- Open Disk Defragmenter and do nothing else for a while.
- Open a second tab and meet yourself.
- Dial the Antler Lodge in Telepath. It is always engaged.
- Dial the Midnight Carnival at 2400 bps and watch the login screen paint.
- In the Wyrm, bank your gold before you go into the forest. You lose what
  you are carrying when you die and you will die a lot.
- Ask the Midnight Carnival for a file, and see what it says about ratios.
- Throw a coin in the fountain, then come back tomorrow.
- Watch the town map for a few seconds without clicking anything.
