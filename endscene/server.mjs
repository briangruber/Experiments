// The server.
//
// One Node process, no framework, no build step. It serves the web UI, reads
// and writes the workspace on disk, and queues the slow work.
//
// It is deliberately a local tool. There is no auth and no multi-tenancy
// because this is a thing you run on your own machine against your own API
// keys, in the way an editor or a DAW is — the work lives in a directory you
// can see, and closing the tab does not lose anything.
//
// Every route below the workspace is scoped to a project. Scenes get two route
// shapes rather than one optional segment, because a film genuinely has no
// episode and threading a null through every path would be a lie about the
// data:
//
//   /api/project/:p/scene/:sc                film, music video
//   /api/project/:p/episode/:ep/scene/:sc    series

import { createServer } from 'node:http';
import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { join, extname, resolve, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadProject, listProjects, workspacePaths, readJSON, writeJSON, listDir, listTakes,
  select, exists, selectedTake, slug, KINDS, hasEpisodes, allScenes,
  resolveCharacter, resolveLocation, borrowable, borrowersOf,
} from './lib/store.mjs';
import { Jobs } from './lib/jobs.mjs';
import { EDIT_MODELS, IMAGE_MODELS, VIDEO_MODELS, pricing, estimateScene } from './lib/models.mjs';
import {
  buildSheet, buildPlate, buildWardrobeEdit, buildNoteEdit, buildVoicePlate, buildShot,
} from './lib/prompt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, 'web');
const WS = resolve(process.env.ENDSCENE_WORKSPACE || HERE);
const W = workspacePaths(WS);
const PORT = Number(process.env.PORT || 4000);

const jobs = new Jobs();
const clients = new Set();
jobs.on('job', (job) => {
  const line = `data: ${JSON.stringify({ type: 'job', job })}\n\n`;
  for (const res of clients) res.write(line);
});

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.srt': 'text/plain; charset=utf-8',
};

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((ok, fail) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 5e6) { fail(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { fail(e); } });
  });

// Paths are made relative to the workspace, not to one project, because a
// borrowed sheet legitimately lives in another project's directory and still
// has to be servable.
const rel = (p) => p.replace(WS + '/', '');
const url = (p) => `/files/${rel(p)}`;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

async function takesFor(dir, kind) {
  return (await listTakes(dir)).map((t) => ({
    take: t.take, selected: t.selected, kind,
    url: t.file ? url(t.file) : null,
  }));
}

async function characterView(project, id) {
  const c = await readJSON(project.paths.characterJSON(id));
  if (!c) return null;
  const looks = [];
  for (const l of await listDir(project.paths.looks(id))) {
    const meta = await readJSON(project.paths.lookJSON(id, l), {});
    looks.push({
      ...meta, id: l,
      isDefault: l === (c.defaultLook || 'default'),
      sheet: (await exists(project.paths.sheet(id, l))) ? url(project.paths.sheet(id, l)) : null,
      takes: await takesFor(project.paths.look(id, l), 'image'),
    });
  }
  return {
    ...c, id, project: project.id,
    global: !!c.global,
    // Shown before un-sharing, because silently breaking another production's
    // scenes is not an acceptable outcome of flipping a toggle.
    borrowedBy: c.global ? await borrowersOf(WS, project.id, 'character', id) : [],
    looks,
    voice: {
      audio: (await exists(project.paths.voiceAudio(id))) ? url(project.paths.voiceAudio(id)) : null,
      plate: (await exists(project.paths.voicePlate(id))) ? url(project.paths.voicePlate(id)) : null,
      takes: await takesFor(project.paths.voiceDir(id), 'voice'),
    },
  };
}

async function locationView(project, id) {
  const l = await readJSON(project.paths.locationJSON(id));
  if (!l) return null;
  const states = [];
  for (const s of await listDir(project.paths.states(id))) {
    const meta = await readJSON(project.paths.stateJSON(id, s), {});
    states.push({
      ...meta, id: s,
      plate: (await exists(project.paths.plate(id, s))) ? url(project.paths.plate(id, s)) : null,
      takes: await takesFor(project.paths.state(id, s), 'image'),
    });
  }
  return {
    ...l, id, project: project.id, global: !!l.global,
    borrowedBy: l.global ? await borrowersOf(WS, project.id, 'location', id) : [],
    states,
  };
}

async function sceneView(project, ep, sc) {
  const scene = await readJSON(project.paths.sceneJSON(ep, sc));
  if (!scene) return null;
  const shots = [];
  for (const s of scene.shots || []) {
    const dir = project.paths.shot(ep, sc, s.id);
    shots.push({ ...s, takes: await takesFor(dir, 'video'), selected: await selectedTake(dir) });
  }
  const dist = project.paths.sceneDist(ep, sc);
  const cutFile = join(dist, `${sc}.mp4`);
  return {
    ...scene, id: sc, episode: ep, project: project.id,
    shots,
    // Which cast members are borrowed, so the UI can say so rather than making
    // someone open another project to find out.
    cast: await Promise.all((scene.cast || []).map(async (c) => {
      try {
        const r = await resolveCharacter(project, c.character);
        return { ...c, name: r.data.name || r.id, borrowed: r.borrowed, owner: r.owner.id };
      } catch (err) {
        return { ...c, error: err.message };
      }
    })),
    estimate: estimateScene((scene.shots || []).map((s) => ({ ...s, videos: s.chain ? [s.chain] : [] })), {
      resolution: project.show.resolution,
    }),
    bed: (await exists(join(dist, 'bed.mp3'))) ? url(join(dist, 'bed.mp3')) : null,
    cut: (await exists(cutFile)) ? url(cutFile) : null,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const routes = [];
const route = (method, pattern, handler) =>
  routes.push({ method, pattern: new RegExp(`^${pattern}$`), handler });

// Scenes exist at two path shapes depending on the project's kind. Registering
// both against one handler keeps every caller free of the distinction.
const P = '/api/project/([\\w-]+)';
const sceneRoute = (method, tail, handler) => {
  route(method, `${P}/scene/([\\w-]+)${tail}`, (m, b) => handler(m[1], null, m[2], m.slice(3), b));
  route(method, `${P}/episode/([\\w-]+)/scene/([\\w-]+)${tail}`, (m, b) => handler(m[1], m[2], m[3], m.slice(4), b));
};

const project = (id) => loadProject(WS, id);

// --- workspace -------------------------------------------------------------

route('GET', '/api/workspace', async () => {
  const projects = [];
  for (const meta of await listProjects(WS)) {
    const p = await project(meta.id);
    projects.push({
      id: meta.id, title: meta.title || meta.id, kind: meta.kind,
      characters: (await listDir(p.paths.company)).length,
      locations: (await listDir(p.paths.locations)).length,
      scenes: (await allScenes(p)).length,
      episodic: hasEpisodes(meta),
    });
  }
  return { root: WS, projects, kinds: KINDS };
});

route('POST', '/api/project', async (_m, body) => {
  const id = slug(body.id || body.title);
  if (!id) throw new Error('a project needs a title');
  if (await exists(join(W.projects, id, 'project.json'))) throw new Error(`${id} already exists`);
  const kind = KINDS.find((k) => k.id === body.kind)?.id || 'film';
  const next = {
    id, title: body.title || id, kind,
    premise: body.premise || '',
    language: body.language || 'English',
    aspect_ratio: body.aspect_ratio || '16:9',
    resolution: body.resolution || '720p',
    // The spine. These three strings are repeated verbatim in every shot
    // prompt, and repeating them identically is the entire reason two
    // independently generated shots look like the same production.
    style: body.style || '',
    look: body.look || '',
    audio: body.audio || DEFAULT_AUDIO,
    models: {
      video: 'bytedance/seedance-2.5/reference-to-video',
      image: 'fal-ai/nano-banana-2',
      edit: 'fal-ai/nano-banana-2/edit',
    },
  };
  await writeJSON(join(W.projects, id, 'project.json'), next);
  return next;
});

const DEFAULT_AUDIO = `AUDIO: Absolutely no background music. No musical score, no underscore, no soundtrack, no ambient musical drone of any kind — music is added later in the edit and anything musical here has to be thrown away. Generate ONLY diegetic sound that physically exists in this place: the characters' speaking voices, the room, and the small sounds of objects actually in frame.

TIMING: Every spoken line must BEGIN and FULLY FINISH inside the beat it is written on, and all speech must be complete at least one full second before the end of the clip. The final second of the shot is held in silence. Do not let a line still be running at the last frame.`;

route('GET', `${P}`, async (m) => {
  const p = await project(m[1]);
  const company = [];
  for (const id of await listDir(p.paths.company)) {
    const c = await readJSON(p.paths.characterJSON(id), {});
    const look = c.defaultLook || 'default';
    company.push({
      id, name: c.name || id, global: !!c.global,
      sheet: (await exists(p.paths.sheet(id, look))) ? url(p.paths.sheet(id, look)) : null,
      hasVoice: await exists(p.paths.voiceAudio(id)),
      looks: (await listDir(p.paths.looks(id))).length,
    });
  }
  const locations = [];
  for (const id of await listDir(p.paths.locations)) {
    const l = await readJSON(p.paths.locationJSON(id), {});
    const states = await listDir(p.paths.states(id));
    locations.push({
      id, name: l.name || id, states, global: !!l.global,
      plate: states.length && (await exists(p.paths.plate(id, states[0]))) ? url(p.paths.plate(id, states[0])) : null,
    });
  }
  const episodes = [];
  if (p.paths.episodic) {
    for (const id of await listDir(p.paths.episodes)) {
      const e = await readJSON(p.paths.episodeJSON(id), {});
      episodes.push({ id, title: e.title || id, scenes: await listDir(join(p.paths.episode(id), 'scenes')) });
    }
  }
  return {
    ...p.project, id: p.id, root: p.root,
    episodic: p.paths.episodic,
    company, locations, episodes,
    scenes: p.paths.episodic ? [] : await listDir(p.paths.scenes),
  };
});

route('PATCH', `${P}`, async (m, body) => {
  const p = await project(m[1]);
  const next = { ...p.project, ...body, id: p.id };
  await writeJSON(p.paths.project, next);
  return next;
});

route('GET', `${P}/borrowable`, async (m) => borrowable(await project(m[1])));

route('POST', `${P}/episode`, async (m, body) => {
  const p = await project(m[1]);
  if (!p.paths.episodic) throw new Error(`${p.project.title} is a ${p.project.kind} — its scenes sit directly in the project`);
  const id = slug(body.id || body.title);
  if (!id) throw new Error('an episode needs a title');
  await writeJSON(p.paths.episodeJSON(id), { id, title: body.title || id });
  return { id };
});

// --- characters ------------------------------------------------------------

route('GET', `${P}/character/([\\w-]+)`, async (m) =>
  (await characterView(await project(m[1]), m[2])) || { error: 'not found' });

route('POST', `${P}/character`, async (m, body) => {
  const p = await project(m[1]);
  const id = slug(body.id || body.name);
  if (!id) throw new Error('a character needs a name');
  if (await exists(p.paths.characterJSON(id))) throw new Error(`${id} already exists in this project`);
  await writeJSON(p.paths.characterJSON(id), {
    id, name: body.name || id,
    sheet: body.sheet || '', note: body.note || '',
    line: body.line || '', direction: body.direction || '',
    defaultLook: 'default',
    // Private until someone decides otherwise. Sharing a likeness across
    // productions should be a deliberate act, never a default.
    global: false,
  });
  await writeJSON(p.paths.lookJSON(id, 'default'), {
    id: 'default', label: 'Default', wardrobe: body.wardrobe || null, derivedFrom: null,
  });
  return { id };
});

route('PATCH', `${P}/character/([\\w-]+)`, async (m, body) => {
  const p = await project(m[1]);
  const cur = await readJSON(p.paths.characterJSON(m[2]));
  if (!cur) throw new Error('no such character');
  // Un-sharing something other projects are using would break their scenes at
  // shoot time rather than now, so it is refused with the list of users.
  if (cur.global && body.global === false) {
    const used = await borrowersOf(WS, p.id, 'character', m[2]);
    if (used.length) {
      throw new Error(`${used.length} scene(s) in other projects borrow this character — remove them first: ${used.map((u) => `${u.project}/${u.scene}`).join(', ')}`);
    }
  }
  const next = { ...cur, ...body, id: cur.id };
  await writeJSON(p.paths.characterJSON(m[2]), next);
  return next;
});

route('POST', `${P}/character/([\\w-]+)/look`, async (m, body) => {
  const p = await project(m[1]);
  const lookId = slug(body.id || body.label);
  if (!lookId) throw new Error('a look needs a name');
  const c = await readJSON(p.paths.characterJSON(m[2]));
  await writeJSON(p.paths.lookJSON(m[2], lookId), {
    id: lookId, label: body.label || lookId,
    wardrobe: body.wardrobe || null, remove: body.remove || null,
    // Recorded so a look can be re-derived when the default sheet changes, and
    // so nobody mistakes a derived look for an original.
    derivedFrom: c.defaultLook || 'default',
  });
  return { id: lookId };
});

// Draw from scratch. Only ever correct for the default look — every other look
// must be an edit of it, or the face is re-rolled.
route('POST', `${P}/character/([\\w-]+)/look/([\\w-]+)/generate`, async (m) => {
  const p = await project(m[1]);
  const [, , id, lookId] = m;
  const character = await readJSON(p.paths.characterJSON(id));
  const look = await readJSON(p.paths.lookJSON(id, lookId), {});
  const prompt = buildSheet({ show: p.show, character, look });
  return jobs.add({
    lane: 'company', label: `${character.name} — draw ${look.label || lookId}`, detail: prompt,
    run: async ({ log }) => {
      const { generate } = await import('./lib/images.mjs');
      const r = await generate({
        dir: p.paths.look(id, lookId), prompt,
        model: p.show.models?.image || 'fal-ai/nano-banana-2',
        meta: { project: p.id, character: id, look: lookId }, onLog: log,
      });
      log(`take ${r.take} drawn`);
      return { take: r.take };
    },
  });
});

// The wardrobe rule and the describe-a-change box: the same operation with a
// different instruction. Both edit an APPROVED sheet, so the result is the same
// character with one thing altered rather than a fresh roll of the dice.
route('POST', `${P}/character/([\\w-]+)/look/([\\w-]+)/edit`, async (m, body) => {
  const p = await project(m[1]);
  const [, , id, lookId] = m;
  const character = await readJSON(p.paths.characterJSON(id));
  const defaultLook = character.defaultLook || 'default';
  const from = body.from === 'self' ? p.paths.sheet(id, lookId) : p.paths.sheet(id, defaultLook);
  if (!(await exists(from))) throw new Error('no approved sheet to edit — draw and select the default look first');

  const prompt = body.wardrobe
    ? buildWardrobeEdit({ wardrobe: body.wardrobe, remove: body.remove })
    : buildNoteEdit({ instruction: body.instruction });

  return jobs.add({
    lane: 'company',
    label: `${character.name} — ${body.wardrobe ? `wardrobe: ${body.wardrobe.slice(0, 36)}` : String(body.instruction).slice(0, 44)}`,
    detail: prompt,
    run: async ({ log }) => {
      const { edit } = await import('./lib/images.mjs');
      const r = await edit({
        dir: p.paths.look(id, lookId), from, prompt,
        model: p.show.models?.edit || 'fal-ai/nano-banana-2/edit',
        meta: { project: p.id, character: id, look: lookId }, onLog: log,
      });
      log(`take ${r.take} edited`);
      return { take: r.take };
    },
  });
});

route('POST', `${P}/character/([\\w-]+)/look/([\\w-]+)/select`, async (m, body) => {
  const p = await project(m[1]);
  const [, , id, lookId] = m;
  const dir = p.paths.look(id, lookId);
  await select(dir, Number(body.take));
  const chosen = (await listTakes(dir)).find((t) => t.take === Number(body.take));
  if (chosen?.file) await copyFile(chosen.file, p.paths.sheet(id, lookId));
  return { ok: true, take: Number(body.take) };
});

route('POST', `${P}/character/([\\w-]+)/voice`, async (m) => {
  const p = await project(m[1]);
  const id = m[2];
  const character = await readJSON(p.paths.characterJSON(id));
  const sheet = p.paths.sheet(id, character.defaultLook || 'default');
  if (!(await exists(sheet))) throw new Error('cast the look before the voice — the plate is filmed from the sheet');
  const prompt = buildVoicePlate({ show: p.show, character });
  return jobs.add({
    lane: 'company', label: `${character.name} — cast voice`, detail: prompt,
    run: async ({ log }) => {
      const { cast } = await import('./lib/voice.mjs');
      const r = await cast({
        dir: p.paths.voiceDir(id), sheet, prompt,
        model: p.show.models?.video || 'bytedance/seedance-2.5/reference-to-video',
        meta: { project: p.id, character: id }, onLog: log,
      });
      log(`take ${r.take}, ${r.seconds.toFixed(1)}s of clean voice`);
      return { take: r.take };
    },
  });
});

route('POST', `${P}/character/([\\w-]+)/voice/select`, async (m, body) => {
  const p = await project(m[1]);
  const id = m[2];
  const dir = p.paths.voiceDir(id);
  const take = Number(body.take);
  await select(dir, take);
  await copyFile(join(dir, 'takes', `${take}.mp3`), p.paths.voiceAudio(id));
  if (await exists(join(dir, 'takes', `${take}.mp4`))) {
    await copyFile(join(dir, 'takes', `${take}.mp4`), p.paths.voicePlate(id));
  }
  return { ok: true, take };
});

// --- locations -------------------------------------------------------------

route('GET', `${P}/location/([\\w-]+)`, async (m) =>
  (await locationView(await project(m[1]), m[2])) || { error: 'not found' });

route('POST', `${P}/location`, async (m, body) => {
  const p = await project(m[1]);
  const id = slug(body.id || body.name);
  if (!id) throw new Error('a location needs a name');
  if (await exists(p.paths.locationJSON(id))) throw new Error(`${id} already exists in this project`);
  await writeJSON(p.paths.locationJSON(id), {
    id, name: body.name || id, sheet: body.sheet || '', note: body.note || '',
    defaultState: slug(body.state || 'default'), global: false,
  });
  await writeJSON(p.paths.stateJSON(id, slug(body.state || 'default')), {
    id: slug(body.state || 'default'), label: body.state || 'Default', lighting: body.lighting || '',
  });
  return { id };
});

route('PATCH', `${P}/location/([\\w-]+)`, async (m, body) => {
  const p = await project(m[1]);
  const cur = await readJSON(p.paths.locationJSON(m[2]));
  if (!cur) throw new Error('no such location');
  if (cur.global && body.global === false) {
    const used = await borrowersOf(WS, p.id, 'location', m[2]);
    if (used.length) {
      throw new Error(`${used.length} scene(s) in other projects borrow this location — remove them first: ${used.map((u) => `${u.project}/${u.scene}`).join(', ')}`);
    }
  }
  const next = { ...cur, ...body, id: cur.id };
  await writeJSON(p.paths.locationJSON(m[2]), next);
  return next;
});

route('POST', `${P}/location/([\\w-]+)/state`, async (m, body) => {
  const p = await project(m[1]);
  const id = slug(body.id || body.label);
  if (!id) throw new Error('a lighting state needs a name');
  await writeJSON(p.paths.stateJSON(m[2], id), { id, label: body.label || id, lighting: body.lighting || '' });
  return { id };
});

route('POST', `${P}/location/([\\w-]+)/state/([\\w-]+)/generate`, async (m) => {
  const p = await project(m[1]);
  const [, , id, stateId] = m;
  const location = await readJSON(p.paths.locationJSON(id));
  const state = await readJSON(p.paths.stateJSON(id, stateId), {});
  const prompt = buildPlate({ show: p.show, location, state });
  return jobs.add({
    lane: 'company', label: `${location.name} — ${state.label || stateId}`, detail: prompt,
    run: async ({ log }) => {
      const { generate } = await import('./lib/images.mjs');
      const r = await generate({
        dir: p.paths.state(id, stateId), prompt,
        model: p.show.models?.image || 'fal-ai/nano-banana-2',
        aspect: p.show.aspect_ratio || '16:9',
        meta: { project: p.id, location: id, state: stateId }, onLog: log,
      });
      log(`take ${r.take} drawn`);
      return { take: r.take };
    },
  });
});

route('POST', `${P}/location/([\\w-]+)/state/([\\w-]+)/select`, async (m, body) => {
  const p = await project(m[1]);
  const [, , id, stateId] = m;
  const dir = p.paths.state(id, stateId);
  await select(dir, Number(body.take));
  const chosen = (await listTakes(dir)).find((t) => t.take === Number(body.take));
  if (chosen?.file) await copyFile(chosen.file, p.paths.plate(id, stateId));
  return { ok: true, take: Number(body.take) };
});

// --- scenes ----------------------------------------------------------------

sceneRoute('GET', '', async (pid, ep, sc) =>
  (await sceneView(await project(pid), ep, sc)) || { error: 'not found' });

sceneRoute('GET', '/prompt/([\\w-]+)', async (pid, ep, sc, rest) => {
  const p = await project(pid);
  const scene = await readJSON(p.paths.sceneJSON(ep, sc));
  const shot = scene.shots.find((s) => s.id === rest[0]);
  const cast = {};
  for (const c of scene.cast) {
    const r = await resolveCharacter(p, c.character);
    cast[c.character] = r.data;
  }
  const location = (await resolveLocation(p, scene.location)).data;
  return buildShot({ show: p.show, scene, shot, cast, location });
});

sceneRoute('POST', '/shoot', async (pid, ep, sc, _rest, body) => {
  const p = await project(pid);
  const scene = await readJSON(p.paths.sceneJSON(ep, sc));
  const only = body.shots?.length ? scene.shots.filter((s) => body.shots.includes(s.id)) : scene.shots;
  const resolution = body.resolution || p.show.resolution || '720p';

  // One job per shot, all in the serial `shoot` lane. Separate jobs rather than
  // one so a failure halfway leaves the earlier shots printed, and so the UI
  // can show which shot is actually rolling.
  return only.map((shot) =>
    jobs.add({
      lane: 'shoot', label: shot.slate || shot.id, detail: `${scene.title || sc} · ${resolution}`,
      run: async ({ log }) => {
        const { shootShot, uploader, publishSelected } = await import('./lib/shoot.mjs');
        const cast = {};
        for (const c of scene.cast) cast[c.character] = (await resolveCharacter(p, c.character)).data;
        const location = (await resolveLocation(p, scene.location)).data;
        const put = await uploader(p.root);
        const r = await shootShot({
          project: p, episode: ep, scene: { ...scene, id: sc }, shot, cast, location,
          model: p.show.models?.video || 'bytedance/seedance-2.5/reference-to-video',
          resolution, put, onLog: log,
        });
        const dir = p.paths.shot(ep, sc, shot.id);
        if (!(await selectedTake(dir))) await select(dir, r.take);
        await publishSelected(dir);
        log(`take ${r.take} printed`);
        return { shot: shot.id, take: r.take };
      },
    }),
  );
});

sceneRoute('POST', '/shot/([\\w-]+)/select', async (pid, ep, sc, rest, body) => {
  const p = await project(pid);
  const dir = p.paths.shot(ep, sc, rest[0]);
  await select(dir, Number(body.take));
  const { publishSelected } = await import('./lib/shoot.mjs');
  await publishSelected(dir);
  return { ok: true, take: Number(body.take) };
});

sceneRoute('POST', '/bed', async (pid, ep, sc) => {
  const p = await project(pid);
  const scene = await readJSON(p.paths.sceneJSON(ep, sc));
  const seconds = scene.shots.reduce((n, s) => n + ((s.cut?.out ?? Number(s.duration)) - (s.cut?.in ?? 0)), 0);
  const { BED_ADVICE } = await import('./lib/score.mjs');
  const prompt = `${scene.bed?.prompt || 'Sparse, restrained underscore.'} ${BED_ADVICE}`;
  return jobs.add({
    lane: 'company', label: `${scene.title || sc} — compose bed`, detail: prompt,
    run: async ({ log }) => {
      const { compose } = await import('./lib/score.mjs');
      const dist = p.paths.sceneDist(ep, sc);
      const r = await compose({ dir: dist, prompt, seconds, meta: { project: p.id, scene: sc } });
      await mkdir(dist, { recursive: true });
      await copyFile(r.file, join(dist, 'bed.mp3'));
      log(`bed take ${r.take}`);
      return { take: r.take };
    },
  });
});

sceneRoute('POST', '/cut', async (pid, ep, sc, _rest, body) => {
  const p = await project(pid);
  return jobs.add({
    lane: 'default', label: `cut ${sc}`,
    run: async ({ log }) => {
      const scene = await readJSON(p.paths.sceneJSON(ep, sc));
      const shots = scene.shots.map((s) => ({
        id: s.id, slate: s.slate, lines: s.lines,
        file: join(p.paths.shot(ep, sc, s.id), 'selected.mp4'),
        in: s.cut?.in ?? 0, out: s.cut?.out ?? Number(s.duration),
      }));
      for (const s of shots) {
        if (!(await exists(s.file))) throw new Error(`${s.id} has no selected take`);
      }
      const dist = p.paths.sceneDist(ep, sc);
      const { write: writeSubs } = await import('./lib/subs.mjs');
      const { cut, attachSubtitles } = await import('./lib/cut.mjs');

      let subtitle = null, written = {}, warnings = [];
      if (!body.noSubs) {
        const langs = [...new Set(scene.shots.flatMap((s) =>
          (s.lines || []).flatMap((l) => Object.keys(l).filter((k) => k !== 'speaker'))))];
        const r = await writeSubs(shots, dist, sc, { languages: langs.length ? langs : ['en'] });
        written = r.written; warnings = r.warnings;
        subtitle = written[body.lang || 'en'] || Object.values(written)[0] || null;
        for (const w of warnings) log(`warning: ${w}`);
      }

      const raw = join(dist, `${sc}.raw.mp4`);
      const out = join(dist, `${sc}.mp4`);
      log('encoding…');
      await cut({
        shots, out: Object.keys(written).length ? raw : out,
        bed: body.noBed ? null : join(dist, 'bed.mp3'),
        subtitles: subtitle, cwd: p.root,
      });
      if (Object.keys(written).length) {
        await attachSubtitles({ video: raw, srt: written, out, cwd: p.root });
        const { rm } = await import('node:fs/promises');
        await rm(raw, { force: true });
      }
      log('cut');
      return { url: url(out), warnings };
    },
  });
});

sceneRoute('GET', '/check', async (pid, ep, sc) => {
  const p = await project(pid);
  const scene = await readJSON(p.paths.sceneJSON(ep, sc));
  const shots = scene.shots.map((s) => ({
    id: s.id, lines: s.lines,
    file: join(p.paths.shot(ep, sc, s.id), 'selected.mp4'),
    in: s.cut?.in ?? 0, out: s.cut?.out ?? Number(s.duration),
  }));
  const { report } = await import('./lib/continuity.mjs');
  const voices = [];
  for (const c of scene.cast) {
    const used = scene.shots.filter((s) => (s.lines || []).some((l) => l.speaker === c.character)).map((s) => s.id);
    if (!used.length) continue;
    const r = await resolveCharacter(p, c.character);
    voices.push({ character: c.character, plate: r.paths.voiceAudio(r.id), shots: used });
  }
  return report({ shots, voices });
});

// --- misc ------------------------------------------------------------------

route('GET', '/api/models', async () => {
  const ids = [...EDIT_MODELS, ...IMAGE_MODELS, ...VIDEO_MODELS].map((m) => m.id);
  const prices = await pricing(ids, { cacheDir: WS });
  const decorate = (list) => list.map((m) => ({ ...m, pricing: prices[m.id]?.pricing || null }));
  return { edit: decorate(EDIT_MODELS), image: decorate(IMAGE_MODELS), video: decorate(VIDEO_MODELS) };
});

route('GET', '/api/jobs', async () => jobs.list());

// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const path = decodeURIComponent(u.pathname);

  if (path === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Workspace files. Normalised and prefix-checked so a crafted path cannot
  // walk out of the workspace.
  if (path.startsWith('/files/')) {
    const target = normalize(join(WS, path.slice('/files/'.length)));
    if (!target.startsWith(WS)) return send(res, 403, { error: 'outside the workspace' });
    try {
      return send(res, 200, await readFile(target), MIME[extname(target)] || 'application/octet-stream');
    } catch {
      return send(res, 404, { error: 'not found' });
    }
  }

  if (path.startsWith('/api/')) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = path.match(r.pattern);
      if (!m) continue;
      try {
        const body = ['POST', 'PATCH'].includes(req.method) ? await readBody(req) : null;
        return send(res, 200, (await r.handler(m, body)) ?? {});
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }
    return send(res, 404, { error: `no route for ${req.method} ${path}` });
  }

  const file = path === '/' ? 'index.html' : path.replace(/^\//, '');
  const target = normalize(join(WEB, file));
  if (!target.startsWith(WEB)) return send(res, 403, 'no');
  try {
    return send(res, 200, await readFile(target), MIME[extname(target)] || 'text/plain');
  } catch {
    return send(res, 404, 'not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n  endscene\n  workspace  ${WS}\n  http://localhost:${PORT}\n`);
});
