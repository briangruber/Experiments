# Halcyon Online

A 1997 computer you can switch on, dial into, and talk to people on.

You land in a dark room with a beige tower. Press the power button and it
POSTs, counts its memory, and boots **Panes 95**. On the desktop, among the
other things a machine of that vintage had, is **Halcyon Online 3.0**.
Double-click it, sign on with any name, and listen to the whole modem
handshake — off-hook click, dial tone, touch tones, ring, answer tone, the
warble, four bongs, the descending hiss — before the room opens.

Halcyon is invented. It is not any service that existed.

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
npm run relay      # the optional multi-user relay
```

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

This is the part that could spiral, so it is built as one pipeline that
everything you type goes through before anyone else sees it
(`src/core/safety.js`, tested in `tools/test.mjs`):

1. **Shape** — length, line count, and a token bucket. Normal conversation
   is never throttled; a burst is.
2. **Privacy** — telephone numbers, street addresses, e-mail addresses,
   card numbers and government numbers are removed before the message
   leaves your machine. This is the one that matters most, and it is also
   perfectly in period: it was the advice everybody got.
3. **Conduct** — a small mild-language pass that masks rather than blocks.
   Whole-word matching only, so it does not mask "hello", "bass" or
   "Scunthorpe"; it does see through `h3ll` and `heeellll`. Operators
   running the relay supply their own list with `--blocklist`.

Then the in-fiction layer, which is both the safety valve and one of the
most nostalgic things about the era: three warnings and a Guide removes you
from the rooms for a minute. Every instant message window has a Report
button, and it does something. Every chat room has Ignore.

Two beats are deliberately educational rather than decorative. A member
called **HaIcyon Billing** — capital i, not an l — will eventually ask for
your password by instant message; reply and a Guide arrives to explain the
trick. The same message is sitting in your mailbox. Type your telephone
number into a room and watch what the service does with it, and what the
room says to you about it.

The strongest control is not code at all: the default transport is
local-only, so out of the box there is nobody to be unsafe towards.

Nothing is stored except in this browser's `localStorage`: which screen
names you have used, which mail you have read, guestbook entries, and hit
counters.

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
    sites/web.js      the World Wide Web, as data
    browser.js  minehunt.js  sketchpad.js  jukebox.js  defrag.js
    notepad.js  mycomputer.js  recycle.js  screensaver.js  assistant.js
  style/              chrome.css (the OS), halcyon.css (apps), web.css (pages)
tools/
  check.mjs           static checks, no browser
  test.mjs            safety layer and relay behaviour
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
