# PEEKED — build & playtest record

## How it was chosen

20 ideas generated across 5 creative lenses (social reveal, skill ghost, creation
chain, deduction/bluff, weird wildcard), then scored 1–10 by three independent
judges on virality, fun-depth, and feasibility.

| idea | total |
|---|---|
| TRACE ME | 22 / 30 |
| CONVERGE | 21 / 30 |
| **PEEKED** | **21 / 30** |
| ONE LINE PHONE | 20 / 30 |
| TELLS | 20 / 30 |

The selector deliberately passed over the top scorer. Its argument: in TRACE ME,
CONVERGE, ONE LINE PHONE and TELLS you could delete the friend and still have a
game — multiplayer is decoration. In PEEKED the recorded choice physically
rewrites the next player's interface, so a peeker manufactures more peekers.
Growth sits inside the rules rather than bolted onto the end.

Runner-up TRACE ME is the pick if certainty beats ceiling — every technical
question is answered before the first line of code. It was passed over because
its share artifact is a score card, and a score card advertises the game while a
chain of custody tells a story about a person.

Honest excitement: **8/10**.

## Two changes made to the original pitch

1. **Failing honestly is a celebrated outcome, not a loss.** Three results exist —
   solved clean, failed clean 🪦, peeked 👁 — and the peek flag is orthogonal to
   success. This closes the trap where a player who knows they're losing peeks
   because they have nothing left to protect. You see the answer either way when
   the game ends; the only thing peeking costs you is the record.
2. **The contagion is a gradient, not a boolean.** The button's size, colour,
   placement and copy are continuous functions of the fraction of the chain that
   peeked. A boolean is a joke you get in ten seconds; a gradient is pressure you
   have to physically resist for four minutes.

## Difficulty tuning

Tuned by solver simulation before any UI existed, since the whole design collapses
if the puzzle is wrong. Two solvers: a perfect one that always guesses a
consistent candidate, and a "human-ish" one with imperfect memory.

| pool | perfect median | human-ish median | human-ish fail |
|---|---|---|---|
| 7 | 3 | — | — |
| 8 | 4 | 4 | 3.0% |
| **9** | **4** | **4** | **7.6%** |
| 10 | 4 | — | — |

Chose **9**. Pool 7 solves in 3 and leaves no desperation for the button to feed
on. Pool 9 keeps the median in the target 4–5 band while producing a real honest-
failure tail, so 🪦 is an outcome people actually reach. It also lays out as a
clean 3×3 palette on a phone.

## Verification

`npm run test:peeked` — 30 headless checks: URL round-tripping over 300 random
chains, secret determinism and distribution across 400 days, board mechanics and
feedback, refresh persistence (a peek must be un-refreshable), the contagion
gradient at three levels, tampered/malformed/future-dated links, 320px layout, and
the viewer theme-toggle override.

## What is still unproven

The behavioural bet. The design needs to land in a narrow band: if nobody presses
the button the mechanic is inert and this is a slower Wordle; if everyone presses
it immediately there's no streak worth protecting. That cannot be verified without
real players, which is what the current playtest is for.

## Kill criteria

Scrap, or redesign from scratch, if any of these hold in real play:

- Across 10+ testers, **zero** people press the button — the moral tension is imaginary.
- The inverse: nearly everyone presses it on their first play.
- Median solve lands at 3-or-below, or 6-or-fail, and pool size can't move it.
- Chains die at length 2 in the wild — the reciprocity gesture isn't happening.
- People screenshot the emoji grid but never the chain line — the chain is decoration.
- A tester needs the chain card explained. It must be legible unaided in 5 seconds.
- Nobody reacts emotionally to breaking a streak. A shrug means the collectively-held
  object doesn't exist and the design rests on nothing.
