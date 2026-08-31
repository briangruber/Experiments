#!/bin/sh
# Re-pack every cast atlas from the pulled AutoSprite sheets.
#
# These four commands were reconstructed from sheet geometry after the fact,
# because nothing recorded them: the atlas JSON says what came out and the
# ledger says what was pulled, and neither says how one became the other. A
# change to the packer could not be applied to the cast without guessing.
# It is a shell script rather than a note in a document so it stays true.
set -e
cd "$(dirname "$0")/.."
A=assets/cast/autosprite

node tools/sheet-cut.mjs --name grout --grid 5x4 --down 1 --once drink \
  idle=$A/grout/idle.png walk=$A/grout/walk.png \
  drink=$A/grout/drink.png asleep=$A/grout/asleep.png

node tools/sheet-cut.mjs --name bonny --grid 5x4 --down 1 --once bellows \
  idle=$A/bonny/idle.png walk=$A/bonny/walk.png \
  run=$A/bonny/run.png bellows=$A/bonny/bellows.png

node tools/sheet-cut.mjs --name pike --grid 5x4 --down 1 --once bell \
  idle=$A/pike/idle.png walk=$A/pike/walk.png \
  despair=$A/pike/despair.png bell=$A/pike/ring-the-bell.png

node tools/sheet-cut.mjs --name cat --grid 5x4 --down 1 --once sneeze \
  idle=$A/cat/crouch.png sneeze=$A/cat/sneeze.png scarper=$A/cat/scarper.png
