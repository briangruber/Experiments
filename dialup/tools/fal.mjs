/*
 * A very small fal.ai client, used once to generate the artwork and the
 * voice clips that ship inside src/assets/.
 *
 *   node tools/fal.mjs run <model> '<json>'        -> prints the response
 *   node tools/fal.mjs get <url> <outfile>         -> downloads a result
 *
 * Nothing in the prototype calls this at run time; the generated files are
 * committed so the folder still works with no network and no key. It is
 * here so the assets can be regenerated or re-styled later.
 *
 * Needs FAL_KEY in the environment.
 */

import { writeFileSync } from 'node:fs';

const KEY = process.env.FAL_KEY;

export async function run(model, input) {
  if (!KEY) throw new Error('FAL_KEY is not set');
  const res = await fetch('https://fal.run/' + model, {
    method: 'POST',
    headers: { Authorization: 'Key ' + KEY, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(model + ' -> ' + res.status + ' ' + text.slice(0, 400));
  return JSON.parse(text);
}

export async function download(url, out) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('download ' + res.status + ' ' + url);
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  return out;
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'run') console.log(JSON.stringify(await run(a, JSON.parse(b)), null, 2));
  else if (cmd === 'get') console.log(await download(a, b));
  else { console.error('usage: fal.mjs run <model> <json> | get <url> <file>'); process.exit(1); }
}
