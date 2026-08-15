#!/usr/bin/env node
// Bring a project up to the current schema.
//
//   node bin/migrate.mjs [workspace]
//
// Idempotent and non-destructive: it adds fields that are now expected and
// renames show.json to project.json, and it never touches a take, a sheet or a
// selection. Re-running it on an up-to-date workspace does nothing.
//
// It exists because the alternative — regenerating projects from a script —
// would discard takes, and takes cannot be regenerated. The video endpoint has
// no seed, so a migration that recreates rather than edits is a migration that
// destroys work.

import { rename } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON, writeJSON, exists, listDir, listProjects, workspacePaths } from '../lib/store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = resolve(process.argv[2] || join(HERE, '..'));
const W = workspacePaths(WS);

let changed = 0;
const did = (msg) => { console.log(`  ${msg}`); changed++; };

for (const id of await listDir(W.projects)) {
  const root = join(W.projects, id);
  const showPath = join(root, 'show.json');
  const projectPath = join(root, 'project.json');

  // show.json → project.json. The old name assumed every production was a
  // show; a feature and a music video are not.
  if ((await exists(showPath)) && !(await exists(projectPath))) {
    await rename(showPath, projectPath);
    did(`${id}: show.json → project.json`);
  }

  const project = await readJSON(projectPath, null);
  if (!project) continue;

  const before = JSON.stringify(project);
  project.id ??= id;
  // Inferred from the shape already on disk rather than guessed: a project with
  // an episodes/ directory is a series, and anything else is a film until its
  // owner says otherwise.
  if (!project.kind) {
    project.kind = (await exists(join(root, 'episodes'))) ? 'series' : 'film';
    did(`${id}: kind inferred as ${project.kind}`);
  }
  if (JSON.stringify(project) !== before) await writeJSON(projectPath, project);

  // Visibility defaults to private. Sharing has to be a decision someone makes,
  // never something a migration turns on for them.
  for (const c of await listDir(join(root, 'company'))) {
    const p = join(root, 'company', c, 'character.json');
    const data = await readJSON(p, null);
    if (data && data.global === undefined) {
      await writeJSON(p, { ...data, global: false });
      did(`${id}/${c}: visibility → project only`);
    }
  }
  for (const l of await listDir(join(root, 'locations'))) {
    const p = join(root, 'locations', l, 'location.json');
    const data = await readJSON(p, null);
    if (data && data.global === undefined) {
      await writeJSON(p, { ...data, global: false });
      did(`${id}/${l}: visibility → project only`);
    }
  }
}

const projects = await listProjects(WS);
console.log(
  changed
    ? `\n${changed} change(s) across ${projects.length} project(s)`
    : `\nnothing to do — ${projects.length} project(s) already current`,
);
