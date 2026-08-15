#!/usr/bin/env node
// endscene — the command line.
//
//   endscene serve [--project P] [--port 4000]
//   endscene cut <episode> <scene> [--project P] [--no-bed] [--no-subs] [--lang en]
//   endscene shoot <episode> <scene> [shot…] [--res 480p] [--takes 1]
//   endscene estimate <episode> <scene> [--res 480p]
//   endscene check <episode> <scene>
//   endscene prompt <episode> <scene> [shot]     print prompts, generate nothing
//
// The UI drives the same library this does. Anything you can do in the browser
// you can do here, which matters because a shoot is a long-running spend and
// people reasonably want to script it.

import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject, readJSON, listDir, exists } from '../lib/store.mjs';
import { estimateScene, pricing, EDIT_MODELS } from '../lib/models.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));

const projectRoot = resolve(opt('project', join(HERE, '..', 'projects', 'telenovela')));

async function loadScene(project, episodeId, sceneId) {
  const scene = await readJSON(project.paths.sceneJSON(episodeId, sceneId));
  if (!scene) throw new Error(`no scene ${episodeId}/${sceneId}`);
  const cast = {};
  for (const c of scene.cast) {
    cast[c.character] = await readJSON(project.paths.characterJSON(c.character));
  }
  const location = await readJSON(project.paths.locationJSON(scene.location));
  return { scene, cast, location };
}

// Marks into each generated take. A shot is generated longer than it plays so
// the edit has handles; this is where they get spent.
function marksFor(project, episodeId, scene) {
  return scene.shots.map((s) => ({
    id: s.id,
    slate: s.slate,
    lines: s.lines,
    file: join(project.paths.shot(episodeId, scene.id, s.id), 'selected.mp4'),
    in: s.cut?.in ?? 0,
    out: s.cut?.out ?? Number(s.duration),
  }));
}

async function main() {
  switch (cmd) {
    case 'serve': {
      process.env.ENDSCENE_PROJECT = projectRoot;
      process.env.PORT = opt('port', '4000');
      await import('../server.mjs');
      return;
    }

    case 'cut': {
      const [episodeId, sceneId] = positional;
      const project = await loadProject(projectRoot);
      const { scene } = await loadScene(project, episodeId, sceneId);
      const shots = marksFor(project, episodeId, scene);

      for (const s of shots) {
        if (!(await exists(s.file))) throw new Error(`${s.id}: no selected take — run \`endscene shoot\` or pick one in the UI`);
      }

      const dist = project.paths.sceneDist(episodeId, sceneId);
      const { write: writeSubs } = await import('../lib/subs.mjs');
      const { cut, attachSubtitles } = await import('../lib/cut.mjs');

      let subtitle = null;
      let written = {};
      let warnings = [];
      if (!flag('no-subs')) {
        // Built here rather than as a step you can forget: a stale .srt against
        // a recut picture is worse than no titles at all.
        const langs = [...new Set(scene.shots.flatMap((s) => (s.lines || []).flatMap((l) => Object.keys(l).filter((k) => k !== 'speaker'))))];
        const res = await writeSubs(shots, dist, sceneId, { languages: langs.length ? langs : ['en'] });
        written = res.written;
        warnings = res.warnings;
        subtitle = written[opt('lang', 'en')] || Object.values(written)[0] || null;
      }

      const bed = flag('no-bed') ? null : join(dist, 'bed.mp3');
      const raw = join(dist, `${sceneId}.raw.mp4`);
      const out = join(dist, `${sceneId}.mp4`);

      console.log(`\ncutting ${scene.title || sceneId}\n`);
      for (const s of shots) console.log(`  ${(s.slate || s.id).padEnd(26)} ${s.in.toFixed(2)}–${s.out.toFixed(2)}  (${(s.out - s.in).toFixed(2)}s)`);
      const total = shots.reduce((n, s) => n + (s.out - s.in), 0);
      console.log(`  ${'—'.repeat(26)} ${total.toFixed(2)}s total`);
      console.log(`  bed:  ${!flag('no-bed') && (await exists(bed)) ? 'yes, ducked under dialogue' : 'none'}`);
      console.log(`  subs: ${subtitle ? `${opt('lang', 'en')} burned in` : 'none'}\n`);
      for (const w of warnings) console.warn(`  ! ${w}`);

      const target = Object.keys(written).length ? raw : out;
      const r = await cut({ shots, out: target, bed, subtitles: subtitle, cwd: project.root });
      if (Object.keys(written).length) {
        await attachSubtitles({ video: raw, srt: written, out, cwd: project.root });
        const { rm } = await import('node:fs/promises');
        await rm(raw, { force: true });
      }
      console.log(`  ${(r.bytes / 1e6).toFixed(1)} MB  ->  ${out.replace(project.root + '/', '')}`);
      return;
    }

    case 'estimate': {
      const [episodeId, sceneId] = positional;
      const project = await loadProject(projectRoot);
      const { scene } = await loadScene(project, episodeId, sceneId);
      const res = opt('res', project.show.resolution || '720p');
      const e = estimateScene(
        scene.shots.map((s) => ({ ...s, videos: s.chain ? [s.chain] : [] })),
        { resolution: res },
      );
      console.log(`\n${scene.title || sceneId} at ${res}\n`);
      for (const r of e.rows) {
        console.log(`  ${(r.slate || r.id).padEnd(26)} ${String(r.seconds).padStart(2)}s${r.videoRefSeconds ? ` +${r.videoRefSeconds}s ref` : '       '}  $${r.cost.toFixed(2)}`);
      }
      console.log(`  ${'—'.repeat(26)}                 $${e.total.toFixed(2)}`);
      console.log(`\n  Approximate. fal bills on tokens, and a video reference is billed for its own input seconds too.\n`);
      return;
    }

    case 'prompt': {
      const [episodeId, sceneId, shotId] = positional;
      const project = await loadProject(projectRoot);
      const { scene, cast, location } = await loadScene(project, episodeId, sceneId);
      const { buildShot } = await import('../lib/prompt.mjs');
      for (const shot of scene.shots) {
        if (shotId && shot.id !== shotId) continue;
        const built = buildShot({ show: project.show, scene, shot, cast, location });
        console.log(`\n${'='.repeat(72)}\n${shot.slate || shot.id}  (${shot.duration}s)\n${'='.repeat(72)}`);
        console.log(`images: ${built.images.map((i) => i.character || `${i.location}/${i.state}`).join(', ')}`);
        console.log(`voices: ${built.audios.map((a) => a.character).join(', ') || '—'}`);
        console.log(`videos: ${built.videos.map((v) => v.shot).join(', ') || '—'}`);
        console.log(`\n${built.prompt}\n`);
      }
      return;
    }

    case 'shoot': {
      const [episodeId, sceneId, ...only] = positional;
      const project = await loadProject(projectRoot);
      const { scene, cast, location } = await loadScene(project, episodeId, sceneId);
      const { shootShot, uploader, publishSelected } = await import('../lib/shoot.mjs');
      const { select } = await import('../lib/store.mjs');
      const put = await uploader(project.root);
      const model = project.show.models?.video || 'bytedance/seedance-2.5/reference-to-video';
      const resolution = opt('res', project.show.resolution || '720p');
      const rounds = Number(opt('takes', '1'));

      const list = only.length ? scene.shots.filter((s) => only.includes(s.id)) : scene.shots;
      console.log(`\n${scene.title || sceneId} — ${list.length} shot(s) at ${resolution}\n`);

      for (const shot of list) {
        for (let i = 0; i < rounds; i++) {
          console.log(`  ${shot.slate || shot.id} — rolling…`);
          const r = await shootShot({
            project, episode: episodeId, scene, shot, cast, location, model, resolution, put,
            onLog: (m) => console.log(`      ${m}`),
          });
          const dir = project.paths.shot(episodeId, sceneId, shot.id);
          // First take of a shot is auto-selected so a fresh scene is
          // immediately cuttable. Later takes never steal the selection —
          // choosing is the human's job.
          const { selectedTake } = await import('../lib/store.mjs');
          if (!(await selectedTake(dir))) await select(dir, r.take);
          await publishSelected(dir);
          console.log(`  ${shot.slate || shot.id} — take ${r.take} printed\n`);
        }
      }
      return;
    }

    case 'check': {
      const [episodeId, sceneId] = positional;
      const project = await loadProject(projectRoot);
      const { scene } = await loadScene(project, episodeId, sceneId);
      const shots = marksFor(project, episodeId, scene);
      const { report } = await import('../lib/continuity.mjs');
      const voices = scene.cast.map((c) => ({
        character: c.character,
        plate: project.paths.voiceAudio(c.character),
        shots: scene.shots.filter((s) => (s.lines || []).some((l) => l.speaker === c.character)).map((s) => s.id),
      })).filter((v) => v.shots.length);

      const r = await report({ shots, voices });
      console.log(`\ncontinuity — ${scene.title || sceneId}   (advisory; nothing here blocks a cut)\n`);
      console.log('  grade (mean luma per shot)');
      for (const row of r.grade.rows) console.log(`    ${row.shot.padEnd(20)} ${row.meanLuma?.toFixed(1) ?? '—'}`);
      for (const p of r.grade.pairs) console.log(`    ${p.from} → ${p.to}: Δ${p.delta.toFixed(1)}${p.flagged ? '   ← large jump' : ''}`);
      console.log('\n  voice (median f0 vs the character\'s plate)');
      for (const v of r.voice) {
        console.log(`    ${v.character}  plate ${v.plateHz?.toFixed(1) ?? '—'} Hz`);
        for (const row of v.rows || []) console.log(`      ${row.shot.padEnd(18)} ${row.hz.toFixed(1)} Hz  ${row.driftPct >= 0 ? '+' : ''}${row.driftPct.toFixed(1)}%${row.flagged ? '   ← drift' : ''}`);
      }
      console.log('\n  timing (silence after the last line)');
      for (const row of r.timing.rows) console.log(`    ${row.shot.padEnd(20)} ${row.tail?.toFixed(2) ?? '—'}s${row.flagged ? `   ← ${row.reason}` : ''}`);
      console.log();
      return;
    }

    case 'models': {
      const p = await pricing(EDIT_MODELS.map((m) => m.id), { cacheDir: projectRoot, force: flag('refresh') });
      console.log('\nimage editing models — pricing live from fal\n');
      for (const m of EDIT_MODELS) {
        console.log(`  ${m.label}${m.recommended ? ' *' : ''}\n    ${m.id}\n    ${p[m.id]?.pricing || 'pricing unavailable'}\n`);
      }
      return;
    }

    default:
      console.log(`endscene — build a show out of AI-generated coverage

  endscene serve      [--project P] [--port 4000]
  endscene cut        <episode> <scene> [--no-bed] [--no-subs] [--lang en]
  endscene shoot      <episode> <scene> [shot…] [--res 480p] [--takes 2]
  endscene estimate   <episode> <scene> [--res 480p]
  endscene prompt     <episode> <scene> [shot]      print prompts, generate nothing
  endscene check      <episode> <scene>             continuity report
  endscene models     [--refresh]                   editing models and live pricing

  --project defaults to projects/telenovela
`);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(`\nerror: ${err.message}\n`);
  process.exit(1);
});
