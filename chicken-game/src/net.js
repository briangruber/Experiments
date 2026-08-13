// Multiplayer seam.
//
// The coop is a deterministic simulation: given a seed and an ordered list of
// tick-stamped events, every client computes the identical world. Nothing here
// talks to a network yet — this module defines the shape that lets one be
// dropped in without touching the simulation.
//
// The rules the rest of the code has to keep to:
//
//   1. The simulation only ever advances in whole fixed ticks (TICK_RATE).
//      Never feed it a wall-clock delta; a 144 Hz monitor and a 30 Hz phone
//      must run the same number of ticks per second of coop time.
//   2. Every draw from the simulation RNG must happen inside a tick, on a
//      path every client takes. Anything cosmetic uses the separate FX RNG.
//   3. Player input never mutates the world directly. It is converted to an
//      event, stamped with the tick it lands on, and applied inside the tick
//      loop — locally today, from a server later.
//   4. Events carry indices and coordinates, never object references or
//      raycast results, so they survive being sent over the wire.
//
// Break any of those and clients silently drift apart. `tools/determinism.mjs`
// is the guard: it runs the same seed and events under wildly different frame
// pacing and asserts the resulting worlds are identical.

export const TICK_RATE = 30;
export const TICK_DT = 1 / TICK_RATE;

// Event types. Payloads must be plain JSON.
export const EV = {
  SEEDS: 'seeds',    // { x, z }        scatter feed on the floor
  POKE: 'poke',      // { chicken }     index into world.chickens
  BULB: 'bulb',      // {}              swat the hanging light
  COLLECT: 'collect', // { egg }        egg id
  // Where a viewer is watching from. Chickens stare at watchers, so this has
  // to be shared state rather than each client's own camera — otherwise
  // "Kevin is staring at you" means something different on every screen, and
  // every client's simulation is steered by its own mouse. Sent about once a
  // second at low precision; ~40 bytes per viewer.
  WATCH: 'watch',    // { id, x, y, z }
  LEAVE: 'leave',    // { id }          viewer disconnected
};

// Events landing on the same tick must be applied in the same order on every
// client, so they sort by (actor, seq) — never by arrival time.
function orderEvents(a, b) {
  if (a.actor !== b.actor) return a.actor < b.actor ? -1 : 1;
  return a.seq - b.seq;
}

export class EventQueue {
  constructor() {
    this.byTick = new Map();
    this.log = [];        // everything ever applied, for replay and debugging
  }

  add(event) {
    const list = this.byTick.get(event.tick);
    if (list) list.push(event);
    else this.byTick.set(event.tick, [event]);
  }

  // Events for this tick, in canonical order. Anything that arrived late for
  // an already-simulated tick is pulled forward rather than dropped, so a
  // slow connection reorders the coop instead of desyncing it.
  drain(tick) {
    let due = null;
    for (const [t, list] of this.byTick) {
      if (t > tick) continue;
      due = due ? due.concat(list) : list;
      this.byTick.delete(t);
    }
    if (!due) return null;
    due.sort(orderEvents);
    for (const e of due) this.log.push(e);
    return due;
  }
}

// Single-player: an event is handed straight back, scheduled for the next
// tick. The same code path a server would use, minus the round trip.
export class LocalTransport {
  constructor(actor = 'local') {
    this.actor = actor;
    this.seq = 0;
    this.handler = null;
  }

  onEvent(fn) { this.handler = fn; }

  send(type, payload, currentTick) {
    const event = { ...payload, type, actor: this.actor, seq: this.seq++, tick: currentTick + 1 };
    this.handler?.(event);
    return event;
  }

  // A local session is always "live"; a remote one reports its clock offset.
  get ready() { return true; }
}

// The shape a networked transport has to implement. Sketched rather than
// built, because the topology decision belongs with the server:
//
//   class RemoteTransport {
//     send(type, payload, currentTick) {
//       // Do NOT apply locally. The server stamps the authoritative tick
//       // (its own clock + a small delay so every client receives it before
//       // simulating that tick) and broadcasts it back to everyone,
//       // including the sender.
//       this.socket.send(JSON.stringify({ type, ...payload }));
//     }
//     onEvent(fn) { this.socket.onmessage = (m) => fn(JSON.parse(m.data)); }
//   }
//
// A joining client needs a starting point. Two options, both supported by
// the simulation as written:
//   - Replay:  { seed, events[] } and fast-forward. Exact, but the cost grows
//              with coop uptime (handle.step(n) does ~36k ticks in ~30 s).
//   - Snapshot: world.snapshot() — a few hundred bytes of transforms and
//              behavior names. Constant cost, and doubles as the drift
//              correction that makes cross-platform lockstep safe.
export const SNAPSHOT_VERSION = 1;
