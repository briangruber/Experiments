// The workspace on disk.
//
// A workspace holds projects. A project is one production and owns its
// characters and its locations. What a project *contains* depends on what kind
// of thing it is:
//
//   film, music-video   →  scenes directly
//   series              →  episodes, and scenes inside them
//
// That is the only structural difference between the kinds, and it is real
// rather than cosmetic: a feature does not have episodes and a series does not
// have a single flat scene list, so pretending otherwise would mean every
// caller carrying a null episode around forever.
//
//   workspace/
//     projects/<project>/
//       project.json                 kind, and the style spine
//       company/<character>/
//         character.json             global: false by default
//         voice/                     plate.mp4, voice.mp3, takes/
//         looks/<look>/              sheet.png, look.json, takes/
//       locations/<location>/
//         location.json              global: false by default
//         states/<state>/plate.png
//       scenes/<scene>/              ← film / music-video
//       episodes/<ep>/scenes/<scene>/← series
//
// Everything is plain JSON and ordinary files. No database: a production is a
// thing people argue about over months, and being able to read, diff, review
// and revert it in git is worth more than any query you would run against it.
//
// Three rules are enforced here rather than left to callers.
//
// 1. Generated files are never overwritten. A new generation is always a new
//    *take*, and choosing between takes is a separate, explicit act. The video
//    endpoint has no seed, so an overwritten take is gone for good.
// 2. Every generated file gets a sidecar with the prompt, the inputs and a hash
//    of them, so the app can say an asset is stale without ever acting on it.
// 3. A project may only borrow another project's character or location if that
//    asset has been made global. Borrowing is by reference — the asset stays
//    where it was made and keeps belonging to the project that made it.

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

// Written atomically. A half-written project.json read by the server on the
// next request is a genuinely confusing failure, and rename is cheap insurance.
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

export const slug = (s) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');

export async function listDir(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

export const KINDS = [
  { id: 'film', label: 'Film', container: 'scenes', note: 'A feature or short. Scenes sit directly in the project.' },
  { id: 'music-video', label: 'Music video', container: 'scenes', note: 'Scenes sit directly in the project.' },
  { id: 'series', label: 'TV series', container: 'episodes', note: 'Episodes hold the scenes.' },
];

export const kindOf = (id) => KINDS.find((k) => k.id === id) || KINDS[0];
export const hasEpisodes = (project) => kindOf(project.kind).container === 'episodes';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
//
// One place that knows the layout. Everything else asks.

export function paths(root, project) {
  const episodic = hasEpisodes(project || { kind: 'series' });

  // The single place the two kinds diverge. A film ignores `episode`
  // entirely — passing one is not an error, it simply has nowhere to go.
  const sceneDir = (episode, scene) =>
    episodic ? join(root, 'episodes', episode, 'scenes', scene) : join(root, 'scenes', scene);

  return {
    root,
    episodic,
    project: join(root, 'project.json'),
    company: join(root, 'company'),
    locations: join(root, 'locations'),
    episodes: join(root, 'episodes'),
    scenes: join(root, 'scenes'),

    character: (c) => join(root, 'company', c),
    characterJSON: (c) => join(root, 'company', c, 'character.json'),
    voiceDir: (c) => join(root, 'company', c, 'voice'),
    voiceAudio: (c) => join(root, 'company', c, 'voice', 'voice.mp3'),
    voicePlate: (c) => join(root, 'company', c, 'voice', 'plate.mp4'),
    looks: (c) => join(root, 'company', c, 'looks'),
    look: (c, l) => join(root, 'company', c, 'looks', l),
    lookJSON: (c, l) => join(root, 'company', c, 'looks', l, 'look.json'),
    sheet: (c, l) => join(root, 'company', c, 'looks', l, 'sheet.png'),

    location: (n) => join(root, 'locations', n),
    locationJSON: (n) => join(root, 'locations', n, 'location.json'),
    states: (n) => join(root, 'locations', n, 'states'),
    state: (n, s) => join(root, 'locations', n, 'states', s),
    stateJSON: (n, s) => join(root, 'locations', n, 'states', s, 'state.json'),
    plate: (n, s) => join(root, 'locations', n, 'states', s, 'plate.png'),

    episode: (e) => join(root, 'episodes', e),
    episodeJSON: (e) => join(root, 'episodes', e, 'episode.json'),
    sceneDir,
    sceneJSON: (episode, scene) => join(sceneDir(episode, scene), 'scene.json'),
    shot: (episode, scene, shot) => join(sceneDir(episode, scene), 'shots', shot),
    sceneDist: (episode, scene) => join(sceneDir(episode, scene), 'dist'),
  };
}

// ---------------------------------------------------------------------------
// Workspace and projects
// ---------------------------------------------------------------------------

export function workspacePaths(root) {
  return { root, projects: join(root, 'projects') };
}

export async function listProjects(wsRoot) {
  const W = workspacePaths(wsRoot);
  const out = [];
  for (const id of await listDir(W.projects)) {
    const meta = await readJSON(join(W.projects, id, 'project.json'), null);
    if (meta) out.push({ ...meta, id, root: join(W.projects, id) });
  }
  return out;
}

export async function loadProject(wsRoot, id) {
  const W = workspacePaths(wsRoot);
  const root = join(W.projects, id);
  const project = await readJSON(join(root, 'project.json'));
  if (!project) throw new Error(`no project "${id}" in ${W.projects}`);
  return { id, root, workspace: wsRoot, project, show: project, paths: paths(root, project) };
}

// ---------------------------------------------------------------------------
// Borrowing
// ---------------------------------------------------------------------------
//
// A reference is either bare ("rosalinda" — this project) or qualified
// ("telenovela/rosalinda" — borrowed from another project). Borrowing is by
// reference: nothing is copied and nothing moves, so the asset keeps belonging
// to the project that made it, and an edit there is seen everywhere it is used.
//
// That last part is the trade and it is deliberate. Sharing a character means
// sharing their likeness, including future changes to it. A project that wants
// its own divergent version should copy rather than borrow — which is a
// different, explicit operation.

export const parseRef = (ref) => {
  const i = String(ref).indexOf('/');
  return i < 0 ? { project: null, id: ref } : { project: ref.slice(0, i), id: ref.slice(i + 1) };
};

export const formatRef = (projectId, id, homeProjectId) =>
  projectId && projectId !== homeProjectId ? `${projectId}/${id}` : id;

// Resolves a character reference to the project that owns it. Refuses to reach
// into another project for something that has not been made global — the whole
// point of the flag is that it is a deliberate decision to share.
export async function resolveCharacter(project, ref) {
  const { project: other, id } = parseRef(ref);
  if (!other || other === project.id) {
    const data = await readJSON(project.paths.characterJSON(id));
    if (!data) throw new Error(`no character "${id}" in ${project.id}`);
    return { owner: project, id, data, paths: project.paths, borrowed: false };
  }
  const home = await loadProject(project.workspace, other);
  const data = await readJSON(home.paths.characterJSON(id));
  if (!data) throw new Error(`no character "${id}" in project "${other}"`);
  if (!data.global) {
    throw new Error(`"${other}/${id}" is not shared — make it global in ${other} before borrowing it`);
  }
  return { owner: home, id, data, paths: home.paths, borrowed: true };
}

export async function resolveLocation(project, ref) {
  const { project: other, id } = parseRef(ref);
  if (!other || other === project.id) {
    const data = await readJSON(project.paths.locationJSON(id));
    if (!data) throw new Error(`no location "${id}" in ${project.id}`);
    return { owner: project, id, data, paths: project.paths, borrowed: false };
  }
  const home = await loadProject(project.workspace, other);
  const data = await readJSON(home.paths.locationJSON(id));
  if (!data) throw new Error(`no location "${id}" in project "${other}"`);
  if (!data.global) {
    throw new Error(`"${other}/${id}" is not shared — make it global in ${other} before borrowing it`);
  }
  return { owner: home, id, data, paths: home.paths, borrowed: true };
}

// Everything this project could borrow: assets in *other* projects that have
// been made global. Its own assets are always available and are not listed.
export async function borrowable(project) {
  const out = { characters: [], locations: [] };
  for (const meta of await listProjects(project.workspace)) {
    if (meta.id === project.id) continue;
    const other = await loadProject(project.workspace, meta.id);
    for (const id of await listDir(other.paths.company)) {
      const c = await readJSON(other.paths.characterJSON(id), {});
      if (c.global) out.characters.push({ ref: `${meta.id}/${id}`, name: c.name || id, project: meta.id, projectTitle: meta.title });
    }
    for (const id of await listDir(other.paths.locations)) {
      const l = await readJSON(other.paths.locationJSON(id), {});
      if (l.global) out.locations.push({ ref: `${meta.id}/${id}`, name: l.name || id, project: meta.id, projectTitle: meta.title });
    }
  }
  return out;
}

// Who is using a shared asset. Asked before un-sharing something, because
// silently breaking another production's scenes is not an acceptable outcome
// of flipping a toggle.
export async function borrowersOf(wsRoot, ownerProjectId, kind, id) {
  const ref = `${ownerProjectId}/${id}`;
  const used = [];
  for (const meta of await listProjects(wsRoot)) {
    if (meta.id === ownerProjectId) continue;
    const p = await loadProject(wsRoot, meta.id);
    for (const loc of await allScenes(p)) {
      const scene = await readJSON(p.paths.sceneJSON(loc.episode, loc.scene), null);
      if (!scene) continue;
      const hit = kind === 'character'
        ? (scene.cast || []).some((c) => c.character === ref)
        : scene.location === ref;
      if (hit) used.push({ project: meta.id, ...loc });
    }
  }
  return used;
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------
//
// Returned as { episode, scene } regardless of kind, so callers never branch on
// it. For a film `episode` is simply null.

export async function allScenes(project) {
  const out = [];
  if (project.paths.episodic) {
    for (const ep of await listDir(project.paths.episodes)) {
      for (const sc of await listDir(join(project.paths.episode(ep), 'scenes'))) {
        out.push({ episode: ep, scene: sc });
      }
    }
  } else {
    for (const sc of await listDir(project.paths.scenes)) out.push({ episode: null, scene: sc });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Takes
// ---------------------------------------------------------------------------
//
// Every generated asset is a numbered take in a `takes/` directory beside a
// `selected` pointer. Selecting writes the number — it copies nothing — so
// changing your mind is free and no take is ever destroyed by a choice.

export async function nextTake(dir) {
  await mkdir(join(dir, 'takes'), { recursive: true });
  const entries = await readdir(join(dir, 'takes')).catch(() => []);
  const numbers = entries.map((f) => Number(f.match(/^(\d+)\./)?.[1])).filter((n) => Number.isFinite(n));
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
  return [...byNumber.values()].sort((a, b) => a.take - b.take)
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
// can reference `sheet.png` rather than `takes/3.png`.
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
// Deliberately inert. It reports and never acts, because regenerating is not a
// build step here — for a shot it is irreversible, and even for an image it is
// a decision about the work.

export async function stale(sidecarPath, inputs) {
  const meta = await readJSON(sidecarPath, null);
  if (!meta) return { stale: true, reason: 'never generated' };
  const now = hash(inputs);
  if (meta.inputsHash !== now) {
    return { stale: true, reason: 'inputs changed since this was generated', was: meta.inputsHash, now };
  }
  return { stale: false };
}
