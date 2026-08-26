/* The honest window. Every prototype should have one. */

import { launch } from './registry.js';

const TEXT = `READ ME FIRST
=============

This is a reconstruction of using a computer in 1997. It runs entirely in
your browser. Nothing here reaches the internet.


THE SERVICE

  Halcyon Online is invented. It is not any service that existed, and the
  resemblance is meant to be to the shape of the era rather than to any
  one company.

  Most of the people in the chat rooms are a few hundred lines of
  JavaScript with opinions about frames and Metallica. They notice what
  you type, they take a believable amount of time to type back, and they
  come and go.


THE OTHER PEOPLE ARE SOMETIMES REAL

  Open this page in a second browser tab. Sign on with a different screen
  name. Walk both of them into the same chat room. They will see each
  other, because tabs talk to each other over a BroadcastChannel that
  never leaves your machine.

  If you want people on other computers, there is a relay:

      node tools/relay.mjs

  It binds to 127.0.0.1 unless you pass --host, it keeps no logs, and it
  holds nothing in memory once everyone leaves. Tick the box on the
  sign-on screen to use it.


HOW THIS STAYS SAFE

  Nobody can type a sentence at anybody. You type whatever you like into
  the box, and what actually travels is the closest phrase from a fixed,
  hand-written list of about two hundred — you can read the whole list
  with the Phrase Book button, or in src/apps/halcyon/phrasebook.js.

  Your keystrokes are read by the matcher and then thrown away. They never
  reach another tab, the relay, or anywhere else.

  That is a stronger promise than screening free text, because it is
  structural rather than a judgement call. There is no filter to outwit,
  no spelling to work around, and no new slur to add to a list next year.
  It is also more in period: chat in 1997 ran on stock phrases anyway.

  The rest still applies. A rate limiter, because a finite vocabulary can
  still be used to flood a room. Three warnings and a Guide removes you
  for a minute. Every instant message window has a Notify button, and it
  does something. Every chat room has Ignore.


THINGS TO TRY

  Type something rude and watch what the box offers to say instead.
  Open the Phrase Book and read it end to end. It is the whole vocabulary.
  Type SCORE in the Trivia Tavern.
  Keyword REVERIE, build a face, and go and stand on the island.
  Play the checkers in Jouster's Keep. It plays properly and it will win.
  Read the mail from "HaIcyon Billing" and look closely at the sender.
  Leave the computer alone for ninety seconds.
  Open Disk Defragmenter and do nothing else for a while.
  Open a second tab and meet yourself in a chat room.


WHY

  The rooms were small enough that you recognised people. There was a
  moderator and they had a name. There was a limit on how fast you could
  talk. Nothing followed you home.

  That is the part worth rebuilding.
`;

export function open(ctx) {
  return launch('notepad', ctx, { name: 'READ ME FIRST.TXT', text: TEXT, readOnly: true });
}
