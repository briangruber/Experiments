// The server.
//
// One Node process, no framework, no build step. It serves the web UI, reads
// and writes the project on disk, and queues the slow work.
//
// It is deliberately a local tool. There is no auth and no multi-tenancy
// because this is a thing you run on your own machine against your own API
// keys, in the way an editor or a DAW is — the project lives in a directory you
// can see, and closing the tab does not lose anything.

import { createServer } from 'node:http';
import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { join, extname, resolve, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadProject, readJSON, writeJSON, listDir, listTakes, select, exists, selectedTake,
} from './lib/store.mjs';
import { Jobs } from './lib/jobs.mjs';
import { EDIT_MODELS, IMAGE_MODELS, VIDEO_MODELS, pricing, estimateScene } from './lib/models.mjs';
import {
  buildSheet, buildPlate, buildWardrobeEdit, buildNoteEdit, buildVoicePlate, buildShot,
} from './lib/prompt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, 'web');
const ROOT = resolve(process.env.ENDSCENE_PROJECT || join(HERE, 'projects', 'telenovela'));
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

// ---------------------------------------------------------------------------
// Reading the project
// ---------------------------------------------------------------------------

const rel = (p) => p.replace(ROOT + '/', '');

async function takesFor(dir, kind) {
  const takes = await listTakes(dir);
  return takes.map((t) => ({
    take: t.take,
    selected: t.selected,
    url: t.file ? `/files/${rel(t.file)}` : null,
    kind,
  }));
}

async function characterView(project, id) {
  const c = await readJSON(project.paths.characterJSON(id));
  if (!c) return null;
  const lookIds = await listDir(join(project.paths.character(id), 'looks'));
  const looks = [];
  for (const l of lookIds) {
    const meta = await readJSON(project.paths.lookJSON(id, l), {});
    const dir = project.paths.look(id, l);
    looks.push({
      ...meta,
      id: l,
      isDefault: l === (c.defaultLook || 'default'),
      sheet: (await exists(project.paths.sheet(id, l))) ? `/files/${rel(project.paths.sheet(id, l))}` : null,
      takes: await takesFor(dir, 'image'),
    });
  }
  const voiceDir = project.paths.voiceDir(id);
  return {
    ...c,
    id,
    looks,
    voice: {
      audio: (await exists(project.paths.voiceAudio(id))) ? `/files/${rel(project.paths.voiceAudio(id))}` : null,
      plate: (await exists(project.paths.voicePlate(id))) ? `/files/${rel(project.paths.voicePlate(id))}` : null,
      takes: await takesFor(voiceDir, 'voice'),
    },
  };
}

async function sceneView(project, ep, sc) {
  const scene = await readJSON(project.paths.sceneJSON(ep, sc));
  if (!scene) return null;
  const shots = [];
  for (const s of scene.shots) {
    const dir = project.paths.shot(ep, sc, s.id);
    shots.push({
      ...s,
      takes: await takesFor(dir, 'video'),
      selected: await selectedTake(dir),
    });
  }
  const dist = project.paths.sceneDist(ep, sc);
  const cutFile = join(dist, `${sc}.mp4`);
  return {
    ...scene,
    episode: ep,
    shots,
    estimate: estimateScene(scene.shots.map((s) => ({ ...s, videos: s.chain ? [s.chain] : [] })), {
      resolution: project.show.resolution,
    }),
    bed: (await exists(join(dist, 'bed.mp3'))) ? `/files/${rel(join(dist, 'bed.mp3'))}` : null,
    cut: (await exists(cutFile)) ? `/files/${rel(cutFile)}` : null,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const routes = [];
const route = (method, pattern, handler) =>
  routes.push({ method, pattern: new RegExp(`^${pattern}$`), handler });

route('GET', '/api/project', async () => {
  const project = await loadProject(ROOT);
  const company = [];
  for (const id of await listDir(project.paths.company)) {
    const c = await readJSON(project.paths.characterJSON(id), {});
    const look = c.defaultLook || 'default';
    company.push({
      id, name: c.name || id,
      sheet: (await exists(project.paths.sheet(id, look))) ? `/files/${rel(project.paths.sheet(id, look))}` : null,
      hasVoice: await exists(project.paths.voiceAudio(id)),
      looks: (await listDir(join(project.paths.character(id), 'looks'))).length,
    });
  }
  const locations = [];
  for (const id of await listDir(project.paths.locations)) {
    const l = await readJSON(project.paths.locationJSON(id), {});
    const states = await listDir(join(project.paths.location(id), 'states'));
    locations.push({
      id, name: l.name || id, states,
      plate: states.length && (await exists(project.paths.plate(id, states[0])))
        ? `/files/${rel(project.paths.plate(id, states[0]))}` : null,
    });
  }
  const episodes = [];
  for (const id of await listDir(project.paths.episodes)) {
    const e = await readJSON(join(project.paths.episode(id), 'episode.json'), {});
    const scenes = await listDir(join(project.paths.episode(id), 'scenes'));
    episodes.push({ id, title: e.title || id, scenes });
  }
  return { root: ROOT, show: project.show, company, locations, episodes };
});

route('GET', '/api/models', async () => {
  const ids = [...EDIT_MODELS, ...IMAGE_MODELS, ...VIDEO_MODELS].map((m) => m.id);
  const prices = await pricing(ids, { cacheDir: ROOT });
  const decorate = (list) => list.map((m) => ({ ...m, pricing: prices[m.id]?.pricing || null }));
  return { edit: decorate(EDIT_MODELS), image: decorate(IMAGE_MODELS), video: decorate(VIDEO_MODELS) };
});

route('POST', '/api/show', async (_m, body) => {
  const project = await loadProject(ROOT);
  const next = { ...project.show, ...body };
  await writeJSON(project.paths.show, next);
  return next;
});

route('GET', '/api/character/([\\w-]+)', async (m) => {
  const project = await loadProject(ROOT);
  return (await characterView(project, m[1])) || { error: 'not found' };
});

route('POST', '/api/character', async (_m, body) => {
  const project = await loadProject(ROOT);
  const id = String(body.id || body.name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  if (!id) throw new Error('a character needs a name');
  if (await exists(project.paths.characterJSON(id))) throw new Error(`${id} already exists`);

  await writeJSON(project.paths.characterJSON(id), {
    id,
    name: body.name || id,
    sheet: body.sheet || '',
    note: body.note || '',
    line: body.line || '',
    direction: body.direction || '',
    defaultLook: 'default',
  });
  await writeJSON(project.paths.lookJSON(id, 'default'), {
    id: 'default', label: 'Default', wardrobe: body.wardrobe || null, derivedFrom: null,
  });
  return { id };
});

route('PATCH', '/api/character/([\\w-]+)', async (m, body) => {
  const project = await loadProject(ROOT);
  const cur = await readJSON(project.paths.characterJSON(m[1]));
  if (!cur) throw new Error('no such character');
  const next = { ...cur, ...body, id: cur.id };
  await writeJSON(project.paths.characterJSON(m[1]), next);
  return next;
});

// Draw a look from scratch. Only ever correct for the default look — every
// other look must be an edit of it, or the face is re-rolled.
route('POST', '/api/character/([\\w-]+)/look/([\\w-]+)/generate', async (m) => {
  const project = await loadProject(ROOT);
  const [, id, lookId] = m;
  const character = await readJSON(project.paths.characterJSON(id));
  const look = await readJSON(project.paths.lookJSON(id, lookId), {});
  const model = project.show.models?.image || 'fal-ai/nano-banana-2';
  const prompt = buildSheet({ show: project.show, character, look });

  return jobs.add({
    lane: 'company', label: `${character.name} — draw ${look.label || lookId}`, detail: prompt,
    run: async ({ log }) => {
      const { generate } = await import('./lib/images.mjs');
      const r = await generate({
        dir: project.paths.look(id, lookId), prompt, model,
        meta: { character: id, look: lookId }, onLog: log,
      });
      log(`take ${r.take} drawn`);
      return { character: id, look: lookId, take: r.take };
    },
  });
});

// The wardrobe rule, and the describe-a-change box — the same operation with a
// different instruction. Both edit the character's APPROVED DEFAULT SHEET, so
// the result is the same character with one thing altered.
route('POST', '/api/character/([\\w-]+)/look/([\\w-]+)/edit', async (m, body) => {
  const project = await loadProject(ROOT);
  const [, id, lookId] = m;
  const character = await readJSON(project.paths.characterJSON(id));
  const defaultLook = character.defaultLook || 'default';
  const model = project.show.models?.edit || 'fal-ai/nano-banana-2/edit';

  // A wardrobe look is derived from the default sheet. A correction to a sheet
  // is derived from that same sheet. Either way the source must be an approved
  // image, never another take.
  const from = body.from === 'self'
    ? project.paths.sheet(id, lookId)
    : project.paths.sheet(id, defaultLook);
  if (!(await exists(from))) throw new Error('no approved sheet to edit — draw and select the default look first');

  const prompt = body.wardrobe
    ? buildWardrobeEdit({ wardrobe: body.wardrobe, remove: body.remove })
    : buildNoteEdit({ instruction: body.instruction });

  return jobs.add({
    lane: 'company',
    label: `${character.name} — ${body.wardrobe ? `wardrobe: ${body.wardrobe.slice(0, 40)}` : body.instruction?.slice(0, 48)}`,
    detail: prompt,
    run: async ({ log }) => {
      const { edit } = await import('./lib/images.mjs');
      const r = await edit({
        dir: project.paths.look(id, lookId), from, prompt, model,
        meta: { character: id, look: lookId, derivedFromLook: body.from === 'self' ? lookId : defaultLook },
        onLog: log,
      });
      log(`take ${r.take} edited`);
      return { character: id, look: lookId, take: r.take };
    },
  });
});

route('POST', '/api/character/([\\w-]+)/look', async (m, body) => {
  const project = await loadProject(ROOT);
  const id = m[1];
  const lookId = String(body.id || body.label || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  if (!lookId) throw new Error('a look needs a name');
  const character = await readJSON(project.paths.characterJSON(id));
  await writeJSON(project.paths.lookJSON(id, lookId), {
    id: lookId,
    label: body.label || lookId,
    wardrobe: body.wardrobe || null,
    remove: body.remove || null,
    // Recorded so a look can be re-derived when the default sheet changes,
    // and so nobody mistakes a derived look for an original.
    derivedFrom: character.defaultLook || 'default',
  });
  return { id: lookId };
});

route('POST', '/api/character/([\\w-]+)/look/([\\w-]+)/select', async (m, body) => {
  const project = await loadProject(ROOT);
  const [, id, lookId] = m;
  const dir = project.paths.look(id, lookId);
  await select(dir, Number(body.take));
  const takes = await listTakes(dir);
  const chosen = takes.find((t) => t.take === Number(body.take));
  if (chosen?.file) await copyFile(chosen.file, project.paths.sheet(id, lookId));
  return { ok: true, take: Number(body.take) };
});

route('POST', '/api/character/([\\w-]+)/voice', async (m) => {
  const project = await loadProject(ROOT);
  const id = m[1];
  const character = await readJSON(project.paths.characterJSON(id));
  const sheet = project.paths.sheet(id, character.defaultLook || 'default');
  if (!(await exists(sheet))) throw new Error('cast the look before the voice — the plate is filmed from the sheet');
  const prompt = buildVoicePlate({ show: project.show, character });
  const model = project.show.models?.video || 'bytedance/seedance-2.5/reference-to-video';

  return jobs.add({
    lane: 'company', label: `${character.name} — cast voice`, detail: prompt,
    run: async ({ log }) => {
      const { cast } = await import('./lib/voice.mjs');
      const r = await cast({ dir: project.paths.voiceDir(id), sheet, prompt, model, meta: { character: id }, onLog: log });
      log(`take ${r.take}, ${r.seconds.toFixed(1)}s of clean voice`);
      return { character: id, take: r.take };
    },
  });
});

route('POST', '/api/character/([\\w-]+)/voice/select', async (m, body) => {
  const project = await loadProject(ROOT);
  const id = m[1];
  const dir = project.paths.voiceDir(id);
  const take = Number(body.take);
  await select(dir, take);
  await copyFile(join(dir, 'takes', `${take}.mp3`), project.paths.voiceAudio(id));
  if (await exists(join(dir, 'takes', `${take}.mp4`))) {
    await copyFile(join(dir, 'takes', `${take}.mp4`), project.paths.voicePlate(id));
  }
  return { ok: true, take };
});

route('GET', '/api/scene/([\\w-]+)/([\\w-]+)', async (m) => {
  const project = await loadProject(ROOT);
  return (await sceneView(project, m[1], m[2])) || { error: 'not found' };
});

route('GET', '/api/scene/([\\w-]+)/([\\w-]+)/prompt/([\\w-]+)', async (m) => {
  const project = await loadProject(ROOT);
  const [, ep, sc, shotId] = m;
  const scene = await readJSON(project.paths.sceneJSON(ep, sc));
  const shot = scene.shots.find((s) => s.id === shotId);
  const cast = {};
  for (const c of scene.cast) cast[c.character] = await readJSON(project.paths.characterJSON(c.character));
  const location = await readJSON(project.paths.locationJSON(scene.location));
  return buildShot({ show: project.show, scene, shot, cast, location });
});

route('POST', '/api/scene/([\\w-]+)/([\\w-]+)/shoot', async (m, body) => {
  const project = await loadProject(ROOT);
  const [, ep, sc] = m;
  const scene = await readJSON(project.paths.sceneJSON(ep, sc));
  const only = body.shots?.length ? scene.shots.filter((s) => body.shots.includes(s.id)) : scene.shots;
  const resolution = body.resolution || project.show.resolution || '720p';

  // One job per shot, all in the serial `shoot` lane. Queued as separate jobs
  // rather than one so a failure halfway leaves the earlier shots printed, and
  // so the UI can show which shot is actually rolling.
  return only.map((shot) =>
    jobs.add({
      lane: 'shoot', label: `${shot.slate || shot.id}`, detail: `${scene.title || sc} · ${resolution}`,
      run: async ({ log }) => {
        const { shootShot, uploader, publishSelected } = await import('./lib/shoot.mjs');
        const cast = {};
        for (const c of scene.cast) cast[c.character] = await readJSON(project.paths.characterJSON(c.character));
        const location = await readJSON(project.paths.locationJSON(scene.location));
        const put = await uploader(project.root);
        const r = await shootShot({
          project, episode: ep, scene, shot, cast, location,
          model: project.show.models?.video || 'bytedance/seedance-2.5/reference-to-video',
          resolution, put, onLog: log,
        });
        const dir = project.paths.shot(ep, sc, shot.id);
        if (!(await selectedTake(dir))) await select(dir, r.take);
        await publishSelected(dir);
        log(`take ${r.take} printed`);
        return { shot: shot.id, take: r.take };
      },
    }),
  );
});

route('POST', '/api/scene/([\\w-]+)/([\\w-]+)/shot/([\\w-]+)/select', async (m, body) => {
  const project = await loadProject(ROOT);
  const [, ep, sc, shotId] = m;
  const dir = project.paths.shot(ep, sc, shotId);
  await select(dir, Number(body.take));
  const { publishSelected } = await import('./lib/shoot.mjs');
  await publishSelected(dir);
  return { ok: true, take: Number(body.take) };
});

route('POST', '/api/scene/([\\w-]+)/([\\w-]+)/bed', async (m) => {
  const project = await loadProject(ROOT);
  const [, ep, sc] = m;
  const scene = await readJSON(project.paths.sceneJSON(ep, sc));
  const seconds = scene.shots.reduce((n, s) => n + ((s.cut?.out ?? Number(s.duration)) - (s.cut?.in ?? 0)), 0);
  const { BED_ADVICE } = await import('./lib/score.mjs');
  const prompt = `${scene.bed?.prompt || 'Sparse, restrained underscore.'} ${BED_ADVICE}`;

  return jobs.add({
    lane: 'company', label: `${scene.title || sc} — compose bed`, detail: prompt,
    run: async ({ log }) => {
      const { compose } = await import('./lib/score.mjs');
      const dist = project.paths.sceneDist(ep, sc);
      const r = await compose({ dir: dist, prompt, seconds, meta: { scene: sc } });
      await mkdir(dist, { recursive: true });
      await copyFile(r.file, join(dist, 'bed.mp3'));
      log(`bed take ${r.take}`);
      return { take: r.take };
    },
  });
});

route('POST', '/api/scene/([\\w-]+)/([\\w-]+)/cut', async (m, body) => {
  const project = await loadProject(ROOT);
  const [, ep, sc] = m;
  return jobs.add({
    lane: 'default', label: `cut ${sc}`,
    run: async ({ log }) => {
      const scene = await readJSON(project.paths.sceneJSON(ep, sc));
      const shots = scene.shots.map((s) => ({
        id: s.id, slate: s.slate, lines: s.lines,
        file: join(project.paths.shot(ep, sc, s.id), 'selected.mp4'),
        in: s.cut?.in ?? 0, out: s.cut?.out ?? Number(s.duration),
      }));
      for (const s of shots) {
        if (!(await exists(s.file))) throw new Error(`${s.id} has no selected take`);
      }
      const dist = project.paths.sceneDist(ep, sc);
      const { write: writeSubs } = await import('./lib/subs.mjs');
      const { cut, attachSubtitles } = await import('./lib/cut.mjs');

      let subtitle = null, written = {}, warnings = [];
      if (!body.noSubs) {
        const langs = [...new Set(scene.shots.flatMap((s) => (s.lines || []).flatMap((l) => Object.keys(l).filter((k) => k !== 'speaker'))))];
        const r = await writeSubs(shots, dist, sc, { languages: langs.length ? langs : ['en'] });
        written = r.written; warnings = r.warnings;
        subtitle = written[body.lang || 'en'] || Object.values(written)[0] || null;
        for (const w of warnings) log(`warning: ${w}`);
      }

      const bedPath = join(dist, 'bed.mp3');
      const raw = join(dist, `${sc}.raw.mp4`);
      const out = join(dist, `${sc}.mp4`);
      log('encoding…');
      await cut({
        shots, out: Object.keys(written).length ? raw : out,
        bed: body.noBed ? null : bedPath, subtitles: subtitle, cwd: project.root,
      });
      if (Object.keys(written).length) {
        await attachSubtitles({ video: raw, srt: written, out, cwd: project.root });
        const { rm } = await import('node:fs/promises');
        await rm(raw, { force: true });
      }
      log('cut');
      return { url: `/files/${rel(out)}`, warnings };
    },
  });
});

route('GET', '/api/scene/([\\w-]+)/([\\w-]+)/check', async (m) => {
  const project = await loadProject(ROOT);
  const [, ep, sc] = m;
  const scene = await readJSON(project.paths.sceneJSON(ep, sc));
  const shots = scene.shots.map((s) => ({
    id: s.id, lines: s.lines,
    file: join(project.paths.shot(ep, sc, s.id), 'selected.mp4'),
    in: s.cut?.in ?? 0, out: s.cut?.out ?? Number(s.duration),
  }));
  const { report } = await import('./lib/continuity.mjs');
  const voices = scene.cast.map((c) => ({
    character: c.character,
    plate: project.paths.voiceAudio(c.character),
    shots: scene.shots.filter((s) => (s.lines || []).some((l) => l.speaker === c.character)).map((s) => s.id),
  })).filter((v) => v.shots.length);
  return report({ shots, voices });
});

route('GET', '/api/jobs', async () => jobs.list());

// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = decodeURIComponent(url.pathname);

  if (path === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Project files. Normalised and prefix-checked so a crafted path cannot walk
  // out of the project directory.
  if (path.startsWith('/files/')) {
    const target = normalize(join(ROOT, path.slice('/files/'.length)));
    if (!target.startsWith(ROOT)) return send(res, 403, { error: 'outside the project' });
    try {
      const body = await readFile(target);
      return send(res, 200, body, MIME[extname(target)] || 'application/octet-stream');
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
  console.log(`\n  endscene\n  project  ${ROOT}\n  http://localhost:${PORT}\n`);
});
