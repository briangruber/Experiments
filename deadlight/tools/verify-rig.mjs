// Checks that a rigged GLB survives being posed.
//
//   node tools/verify-rig.mjs assets/creature.glb [more.glb …]
//   node tools/verify-rig.mjs --all          # everything with a skin
//
// Exits non-zero if any clip tears the mesh apart or folds it up. Run it after
// tools/generate.mjs, before trusting a creature.
//
// This exists because Tripo's auto-rigger is inconsistent in a way that no
// other check catches. The same prompt, run three times, produced skeletons of
// 52, 62 and 78 bones; the 62-bone one animated beautifully, one tore the mesh
// into spaghetti, and one crumpled it onto the floor. All three have
// identical, perfectly clean bind poses and identical bounds, load without a
// warning, and report valid correctly-named clips. The only way to tell them
// apart is to pose the mesh and look at where the vertices went — which is
// what tools/rigcheck.html does, and what this drives.

import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

/**
 * Pass mark: how far a posed mesh may exceed its bind bounds.
 *
 * A healthy humanoid clip lands around 1.0–1.6 — an arm swinging forward
 * genuinely does make the mesh a little wider than its A-pose. A rig with
 * misattached weights lands in the tens or hundreds, because a stray vertex
 * is being dragged to wherever a wrong joint went. There is no ambiguous
 * middle in practice, so the threshold is not delicate.
 */
const LIMIT = Number(flag('limit', 3));

/**
 * Floor for the collapse check: how short a posed biped may get, relative to
 * its bind height, before the retarget is judged to have folded it up.
 *
 * A healthy walk stays above ~0.9 — a stride lowers the hips a little and
 * nothing else. A retarget that has mismapped the spine puts the model face
 * down on the floor at 0.3–0.5, while keeping bounds that look entirely
 * normal to a size check.
 */
const FLOOR = Number(flag('floor', 0.7));
const PORT = Number(flag('port', 8127));

const CHROME = process.env.CHROME_PATH
  ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

function startServer() {
  const proc = spawn(process.execPath, [path.join(ROOT, 'tools/serve.mjs'), '--port', String(PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 8000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes('http://')) {
        clearTimeout(timer);
        resolve(proc);
      }
    });
    proc.on('error', reject);
  });
}

/** Everything in assets/ and assets/raw that might carry a skin. */
async function findCandidates() {
  const out = [];
  for (const dir of ['assets', path.join('assets', 'raw')]) {
    const full = path.join(ROOT, dir);
    if (!existsSync(full)) continue;
    for (const name of await readdir(full)) {
      if (name.endsWith('.glb') && /creature|rig|anim/i.test(name)) {
        out.push(path.join(dir, name));
      }
    }
  }
  return out;
}

async function main() {
  const sweeping = args.includes('--all');
  const targets = sweeping
    ? await findCandidates()
    : args.filter((a) => a.endsWith('.glb'));

  if (!targets.length) {
    console.error('usage: node tools/verify-rig.mjs <file.glb…> | --all');
    process.exit(2);
  }

  const server = await startServer();
  const browser = await chromium.launch({
    headless: false,
    executablePath: CHROME,
    args: ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader',
      '--use-gl=angle', '--use-angle=swiftshader', '--mute-audio'],
  });

  const failures = [];
  try {
    const page = await browser.newPage();
    for (const target of targets) {
      const rel = path.relative(path.join(ROOT, 'tools'), path.join(ROOT, target));
      await page.goto(
        `http://localhost:${PORT}/tools/rigcheck.html?file=${encodeURIComponent(rel)}`,
        { waitUntil: 'domcontentloaded' },
      );
      const result = await page.waitForFunction(() => window.__result, { timeout: 90_000 })
        .then((h) => h.jsonValue());

      if (!result.ok) {
        // A sweep picks up unrigged source meshes too (assets/raw/creature.glb
        // is the mesh *before* rigging). Having no skin is only a failure when
        // the file was named explicitly — then it is a question that was asked.
        if (sweeping && /no skinned mesh/.test(result.error)) {
          console.log(`· ${target}  no rig, skipped`);
          continue;
        }
        console.log(`✗ ${target}\n    ${result.error}`);
        failures.push(target);
        continue;
      }

      const torn = result.worst > LIMIT;
      const collapsed = result.shortest < FLOOR;
      const bad = torn || collapsed;
      console.log(
        `${bad ? '✗' : '✓'} ${target}  ${result.bones} bones` +
        `  spread ×${result.worst}  height ×${result.shortest}  sink ${result.sink}` +
        `${torn ? '  TORN' : ''}${collapsed ? '  COLLAPSED' : ''}`,
      );
      for (const clip of result.clips) {
        const mark = clip.worst > LIMIT || clip.height < FLOOR ? '✗' : ' ';
        console.log(
          `   ${mark} ${clip.name.padEnd(12)} spread ×${String(clip.worst).padEnd(6)}` +
          ` height ×${String(clip.height).padEnd(6)} sink ${String(clip.sink).padEnd(7)}`,
        );
      }
      if (bad) failures.push(target);
    }
  } finally {
    await browser.close();
    server.kill();
  }

  if (failures.length) {
    console.error(
      `\n${failures.length} rig(s) failed: spread must stay under ×${LIMIT} ` +
      `and height above ×${FLOOR} of bind.\n` +
      'Regenerate with a rig-friendlier mesh; see tools/creature-bakeoff.mjs.',
    );
    process.exit(1);
  }
  console.log('\nall rigs pose cleanly');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
