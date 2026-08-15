// The project on disk.
//
// Everything endscene knows lives in plain JSON and ordinary files under
// projects/<show>/. There is no database, and that is a decision rather than
// laziness: a production is a thing people argue about over months, and being
// able to read it, diff it, review it and revert it in git is worth more than
// any query you would ever run against it.
//
// The shape mirrors how a production actually decomposes, and the nesting is
// the lifetime of each thing:
//
//   show.json                     the spine — outlives every episode
//   company/<character>/          identity and voice — outlive every episode
//     looks/<look>/               wardrobe — outlives every scene
//   locations/<location>/
//     states/<state>/             the room in one lighting condition
//   episodes/<ep>/scenes/<scene>/ the script
//     shots/<shot>/takes/         the film itself
//
// Two rules are enforced here rather than left to callers, because both are
// easy to violate by accident and expensive to discover later.
//
// 1. Generated files are never overwritten. A new generation is always a new
//    *take*, and choosing between takes is a separate, explicit act. The video
//    endpoint has no seed, so an overwritten take is gone for good.
//
// 2. Every generated file gets a sidecar recording the prompt, the inputs and
//    a hash of the inputs. That hash is what lets the app tell you an asset is
//    stale without ever acting on it.

import { readFile, writeFile, mkdir, readdir, access, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';

export const exists = (p) => access(p).then(() => true, () => false);

export async function readJSON(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw err;
  }
}

// Written atomically. A half-written show.json read by the server on the next
// request is a genuinely confusing failure, and rename is cheap insurance.
export async function writeJSON(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
  return path;
}

export const hash = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex')
    .slice(0, 16);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
//
// One place that knows the layout. Everything else asks.

export function paths(root) {
  const P = {
    root,
    show: join(root, 'show.json'),
    company: join(root, 'company'),
    locations: join(root, 'locations'),
    episodes: join(root, 'episodes'),
    dist: join(root, 'dist'),

    character: (c) => join(root, 'company', c),
    characterJSON: (c) => join(root, 'company', c, 'character.json'),
    voiceDir: (c) => join(root, 'company', c, 'voice'),
    voiceJSON: (c) => join(root, 'company', c, 'voice', 'voice.json'),
    voiceAudio: (c) => join(root, 'company', c, 'voice', 'voice.mp3'),
    voicePlate: (c) => join(root, 'company', c, 'voice', 'plate.mp4'),

    look: (c, l) => join(root, 'company', c, 'looks', l),
    lookJSON: (c, l) => join(root, 'company', c, 'looks', l, 'look.json'),
    sheet: (c, l) => join(root, 'company', c, 'looks', l, 'sheet.png'),

    location: (n) => join(root, 'locations', n),
    locationJSON: (n) => join(root, 'locations', n, 'location.json'),
    state: (n, s) => join(root, 'locations', n, 'states', s),
    stateJSON: (n, s) => join(root, 'locations', n, 'states', s, 'state.json'),
    plate: (n, s) => join(root, 'locations', n, 'states', s, 'plate.png'),

    episode: (e) => join(root, 'episodes', e),
    scene: (e, s) => join(root, 'episodes', e, 'scenes', s),
    sceneJSON: (e, s) => join(root, 'episodes', e, 'scenes', s, 'scene.json'),
    shot: (e, s, sh) => join(root, 'episodes', e, 'scenes', s, 'shots', sh),
    sceneDist: (e, s) => join(root, 'episodes', e, 'scenes', s, 'dist'),
  };
  return P;
}

// ---------------------------------------------------------------------------
// Takes
// ---------------------------------------------------------------------------
//
// Every generated asset is a numbered take in a `takes/` directory beside a
// `selected` pointer. Selecting copies nothing — it writes the number — so
// changing your mind is free and no take is ever destroyed by a choice.

export async function nextTake(dir) {
  await mkdir(join(dir, 'takes'), { recursive: true });
  const entries = await readdir(join(dir, 'takes')).catch(() => []);
  const numbers = entries
    .map((f) => Number(f.match(/^(\d+)\./)?.[1]))
    .filter((n) => Number.isFinite(n));
  return numbers.length ? Math.max(...numbers) + 1 : 1;
}

export async function listTakes(dir) {
  const entries = await readdir(join(dir, 'takes')).catch(() => []);
  const byNumber = new Map();
  for (const f of entries) {
    const n = Number(f.match(/^(\d+)\./)?.[1]);
    if (!Number.isFinite(n)) continue;
    const rec = byNumber.get(n) || { take: n };
    if (f.endsWith('.json')) rec.meta = join(dir, 'takes', f);
    else rec.file = join(dir, 'takes', f);
    byNumber.set(n, rec);
  }
  const selected = await selectedTake(dir);
  return [...byNumber.values()]
    .sort((a, b) => a.take - b.take)
    .map((t) => ({ ...t, selected: t.take === selected }));
}

export async function selectedTake(dir) {
  const raw = await readFile(join(dir, 'selected'), 'utf8').catch(() => '');
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function select(dir, take) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'selected'), `${take}\n`, 'utf8');
  return take;
}

// The selected take, published under a stable name so the rest of the system
// (and the prompt builder especially) can reference `sheet.png` rather than
// `takes/3.png`. Callers get a real file at a predictable path; the takes
// directory stays the archive.
export async function publish(dir, take, target) {
  const takes = await listTakes(dir);
  const chosen = takes.find((t) => t.take === take);
  if (!chosen?.file) throw new Error(`take ${take} not found in ${dir}`);
  await mkdir(dirname(target), { recursive: true });
  await rm(target, { force: true });
  await writeFile(target, await readFile(chosen.file));
  return target;
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------
//
// Deliberately inert. It reports and never acts, because regenerating is not
// a build step here — for a shot it is irreversible, and even for an image it
// is a decision about the work. `stale()` answers a question; whether anything
// happens next is the human's business.

export async function stale(sidecarPath, inputs) {
  const meta = await readJSON(sidecarPath, null);
  if (!meta) return { stale: true, reason: 'never generated' };
  const now = hash(inputs);
  if (meta.inputsHash !== now) {
    return { stale: true, reason: 'inputs changed since this was generated', was: meta.inputsHash, now };
  }
  return { stale: false };
}

export async function loadProject(root) {
  const P = paths(root);
  const show = await readJSON(P.show);
  if (!show) throw new Error(`no show.json in ${root}`);
  return { root, show, paths: P };
}

export async function listDir(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}
