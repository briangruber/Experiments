import { createWorld } from '/shared/sim.js';
import { WORLD } from '/shared/config.js';

// Solo play runs the real server inside the page. Not a cut-down offline mode:
// it is the same shared/sim.js the hosted server runs, wired to the client
// through a two-line fake socket instead of a WebSocket. Same monsters, same
// economy, same sinking — just nobody else in the water.
//
// This is what makes the single-file build work at all, since a published page
// cannot open a socket to anywhere.

export function attachSoloWorld(net) {
  const world = createWorld();

  // The client speaks to this exactly as it speaks to a socket. Delivery is
  // deferred a microtask so a handler can never re-enter itself mid-send.
  const conn = {
    open: true,
    send(msg) {
      const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
      queueMicrotask(() => net.receive(JSON.parse(data)));
    },
  };

  let player = null;
  net.transport = {
    send(obj) {
      if (!player) {
        if (obj.t !== 'join') return;
        player = world.join(conn, obj);
        return;
      }
      try {
        world.handle(player, obj);
      } catch (err) {
        console.error('solo world error', err);
      }
    },
  };

  // The world ticks on its own clock, independent of the render loop, so a slow
  // frame does not slow the monsters down.
  const timer = setInterval(() => world.step(), 1000 / WORLD.tickRate);

  return {
    world,
    stop() { clearInterval(timer); },
  };
}
