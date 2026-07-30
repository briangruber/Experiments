# Experiments — Viral Browser Multiplayer Games

An ideation-and-prototype pipeline for browser multiplayer games built to spread.

## Approach

Ideas are generated across several creative lenses, scored by independent judges on
virality / fun / feasibility, and only the winner gets prototyped. Prototypes are
play-tested and then either iterated on or scrapped.

## Architecture bias: async link-passing

Prototypes are single static HTML files with no server, no accounts, and no database.
Multiplayer happens by passing a URL that encodes game state — player one plays, gets a
link, sends it to a friend, the friend plays against that state and sends one back.

This makes the share *the game loop itself* rather than a growth feature bolted on, and
it means a prototype can be played on a phone the moment it exists.

## Layout

    games/<game-name>/index.html   self-contained prototype
    docs/                          specs, playtest notes, decisions

## Playtesting

Open the HTML file directly, or serve the directory:

    python3 -m http.server 8000
