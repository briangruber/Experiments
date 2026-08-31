// Measured cost, rather than remembered list prices.
//
// fal exposes the account balance, so a generation can be priced by reading it
// before and after. Two consequences worth stating, because they shape every
// tool that uses this: a matrix has to run strictly sequentially, since two
// generations in flight cannot be separated in a balance delta; and per-call
// figures still carry about one call of billing lag even with the quiesce
// below, so the run's own start-to-end delta is the only exact number.
//
// This is the third tool to need it, which is what made it a module.

const KEY = () => process.env.FAL_KEY;

export async function balance() {
  const r = await fetch('https://rest.alpha.fal.ai/billing/user_balance', {
    headers: { Authorization: `Key ${KEY()}` },
  });
  if (!r.ok) return null;
  const v = parseFloat(await r.text());
  return Number.isFinite(v) ? v : null;
}

// Wait for the balance to go quiet before starting the clock. Reading it while
// the PREVIOUS call's charge is still landing smears one cost onto the next.
export async function quiesce(ms = 25000) {
  const t0 = Date.now();
  let last = await balance();
  while (Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 2000));
    const now = await balance();
    if (now != null && last != null && now === last) return now;
    last = now;
  }
  return last;
}

// And billing settles after the task does, so poll rather than reading once and
// reporting a zero that is really a race. A call whose cost never settles
// reports null and says so, which is the honest answer.
export async function settle(before, ms = 40000) {
  if (before == null) return null;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 2000));
    const now = await balance();
    if (now != null && Math.abs(now - before) > 1e-9) return +(before - now).toFixed(6);
  }
  return null;
}
