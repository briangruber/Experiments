#!/bin/sh
# Re-pack every cast atlas from the pulled AutoSprite sheets.
#
# These four commands were reconstructed from sheet geometry after the fact,
# because nothing recorded them: the atlas JSON says what came out and the
# ledger says what was pulled, and neither says how one became the other. A
# change to the packer could not be applied to the cast without guessing.
# It is a shell script rather than a note in a document so it stays true.
#
# 6x6 because the sheets are 32 frames; --fps 19 because they were 20 frames at
# 12 fps and the motion has to play at the same speed as before, not 60% faster
# (12 * 32/20 = 19.2). Frame count and frame rate are one setting wearing two
# names, and changing the first without the second is how a walk turns into a
# scurry.
set -e
cd "$(dirname "$0")/.."
A=assets/cast/autosprite

node tools/sheet-cut.mjs --name grout --grid 6x6 --down 1 --fps 19 --once drink \
  idle=$A/grout/idle.png walk=$A/grout/walk.png \
  drink=$A/grout/drink.png asleep=$A/grout/asleep.png

node tools/sheet-cut.mjs --name bonny --grid 6x6 --down 1 --fps 19 --once bellows \
  idle=$A/bonny/idle.png walk=$A/bonny/walk.png \
  run=$A/bonny/run.png bellows=$A/bonny/bellows.png

node tools/sheet-cut.mjs --name pike --grid 6x6 --down 1 --fps 19 --once bell \
  idle=$A/pike/idle.png walk=$A/pike/walk.png \
  despair=$A/pike/despair.png bell=$A/pike/ring-the-bell.png

node tools/sheet-cut.mjs --name cat --grid 6x6 --down 1 --fps 19 --once sneeze \
  idle=$A/cat/crouch.png sneeze=$A/cat/sneeze.png scarper=$A/cat/scarper.png
