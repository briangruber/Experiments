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

  Everything you type is screened before anyone else sees it:

    - length and rate limits, so a room cannot be flooded
    - a privacy pass that removes telephone numbers, street addresses,
      e-mail addresses and card numbers before they leave your machine
    - a mild-language filter that masks rather than blocks
    - three warnings and a Guide removes you from the room for a minute

  The last one is not just a safety valve. Being told off by a Guide was
  part of the experience, and rooms were better for it.

  Every instant message window has a Report button, and it does something.


THINGS TO TRY

  Type SCORE in the Trivia Tavern.
  Ask the room a/s/l.
  Type your telephone number in a chat room and watch what happens.
  Read the mail from CoffeeAchiever and download the attachment.
  Read the mail from "HaIcyon Billing" and look closely at the sender.
  Open the Location box in NetScrape and go somewhere that does not exist.
  Sign somebody's guestbook.
  Leave the computer alone for ninety seconds.
  Open Disk Defragmenter and do nothing else for a while.
  Turn the CRT effect off in the tray if it bothers your eyes.


WHY

  The rooms were small enough that you recognised people. There was a
  moderator and they had a name. There was a limit on how fast you could
  talk. Nothing followed you home.

  That is the part worth rebuilding.
`;

export function open(ctx) {
  return launch('notepad', ctx, { name: 'READ ME FIRST.TXT', text: TEXT, readOnly: true });
}
