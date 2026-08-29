// The puzzle dependency graph, as a data structure instead of a whiteboard.
//
// Ron Gilbert's dependency chart is the single most useful artefact in
// adventure design and it is normally a drawing. Making it data buys three
// things a drawing cannot give you:
//
//   1. The game asserts against it. Every gate in the room declares which node
//      it is, so a puzzle you wired backwards fails at load, not in playtest.
//   2. It is lintable. Unreachable nodes and dead ends are the two bugs that
//      make an adventure game unfinishable, and both are graph properties.
//   3. It is generatable-against. This is the file an LLM can safely propose
//      changes to, because the linter will reject an incoherent proposal —
//      which is what makes machine help in design work at all, as opposed to
//      machine help in prose.
//
// A node is a state the world can reach. `needs` are the tokens it consumes or
// requires; `gives` is the token it produces.

export function lint(graph) {
  const problems = [];
  const nodes = graph.nodes;
  const ids = Object.keys(nodes);

  const producedBy = new Map();
  for (const id of ids) {
    const gives = nodes[id].gives;
    if (!gives) continue;
    if (producedBy.has(gives)) {
      problems.push({ level: 'warn', msg: `token "${gives}" is produced by both ${producedBy.get(gives)} and ${id}` });
    }
    producedBy.set(gives, id);
  }

  const start = new Set(graph.start || []);
  for (const id of ids) {
    for (const n of nodes[id].needs || []) {
      if (!start.has(n) && !producedBy.has(n)) {
        problems.push({ level: 'error', msg: `${id} needs "${n}", which nothing produces and the player does not start with` });
      }
    }
  }

  // Forward closure from the starting tokens. Anything not in it is a node the
  // player can never legally trigger — the classic unwinnable-by-construction.
  const have = new Set(start);
  const fired = new Set();
  let moved = true;
  while (moved) {
    moved = false;
    for (const id of ids) {
      if (fired.has(id)) continue;
      if ((nodes[id].needs || []).every((n) => have.has(n))) {
        fired.add(id);
        if (nodes[id].gives) have.add(nodes[id].gives);
        moved = true;
      }
    }
  }
  for (const id of ids) {
    if (!fired.has(id)) problems.push({ level: 'error', msg: `${id} is unreachable — its requirements can never all be satisfied` });
  }
  if (graph.goal && !have.has(graph.goal)) {
    problems.push({ level: 'error', msg: `goal "${graph.goal}" is unreachable` });
  }

  // A node that consumes a token two different nodes need, and does not give it
  // back, is a dead end waiting for a playtester to find it.
  const consumers = new Map();
  for (const id of ids) {
    if (!nodes[id].consumes) continue;
    for (const c of nodes[id].consumes) {
      if (!consumers.has(c)) consumers.set(c, []);
      consumers.get(c).push(id);
    }
  }
  for (const [token, users] of consumers) {
    if (users.length > 1) {
      problems.push({ level: 'error', msg: `"${token}" is consumed by ${users.join(' and ')} but only produced once — spending it on one locks the other` });
    }
  }

  // Longest chain, as a rough read on whether the room is a puzzle or a corridor.
  const depth = new Map();
  const depthOf = (id, seen = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    let d = 0;
    for (const n of nodes[id].needs || []) {
      const p = producedBy.get(n);
      if (p) d = Math.max(d, depthOf(p, seen) + 1);
    }
    depth.set(id, d);
    return d;
  };
  const longest = ids.length ? Math.max(...ids.map((id) => depthOf(id))) : 0;

  return { problems, reachable: fired, tokens: have, longest };
}
