// Making and editing the still references: character sheets and set plates.
//
// Two operations that look similar and are not. Generating draws something new
// from a description. Editing takes an approved image and changes one named
// thing about it while holding everything else. The difference is the whole
// wardrobe rule — see lib/prompt.mjs — and it is why they are separate
// functions here rather than one with a flag.
//
// Everything lands as a numbered take. Nothing is ever overwritten, because
// the alternative is losing an approved likeness to a stray click.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { upload, run, download } from './fal.mjs';
import { nextTake, writeJSON, hash } from './store.mjs';

// Sheets and plates are both wider than tall and want to stay that way. Left
// on `auto` an edit came back at a different aspect than its source, which is
// harmless once and corrosive over a chain of edits — a look derived from a
// look derived from a default drifts a little further each time.
export const SHEET_ASPECT = '3:2';

function pickImage(res) {
  const url =
    res.images?.[0]?.url ||
    res.data?.images?.[0]?.url ||
    res.image?.url ||
    res.data?.image?.url;
  if (!url) throw new Error(`no image in response: ${JSON.stringify(res).slice(0, 300)}`);
  return url;
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

export async function generate({
  dir, prompt, model, aspect = SHEET_ASPECT, resolution = '2K', seed = null, meta = {}, onLog,
}) {
  await mkdir(join(dir, 'takes'), { recursive: true });
  const take = await nextTake(dir);

  const input = {
    prompt,
    num_images: 1,
    aspect_ratio: aspect,
    output_format: 'png',
    ...(resolution ? { resolution } : {}),
    ...(seed != null ? { seed } : {}),
  };

  const res = await run(model, input, { onLog });
  const url = pickImage(res);
  const file = join(dir, 'takes', `${take}.png`);
  await download(url, file);

  await writeJSON(join(dir, 'takes', `${take}.json`), {
    take,
    kind: 'generate',
    model,
    prompt,
    input,
    // Image endpoints accept a seed, unlike the video endpoint, so a still
    // that came out well genuinely can be reproduced. Worth recording.
    seed: res.seed ?? res.data?.seed ?? null,
    source: url,
    made_at: new Date().toISOString(),
    inputsHash: hash({ prompt, model, aspect, resolution, ...meta }),
    ...meta,
  });

  return { take, file };
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------
//
// `from` is a path to an approved image. It becomes @Image1, which is what the
// edit prompts in lib/prompt.mjs refer to.

export async function edit({
  dir, from, prompt, model, aspect = SHEET_ASPECT, resolution = '2K', seed = null, meta = {}, onLog,
}) {
  await mkdir(join(dir, 'takes'), { recursive: true });
  const take = await nextTake(dir);

  const input = {
    prompt,
    image_urls: [await upload(from)],
    num_images: 1,
    // Pinned rather than left on auto: see SHEET_ASPECT above.
    aspect_ratio: aspect,
    output_format: 'png',
    ...(resolution ? { resolution } : {}),
    ...(seed != null ? { seed } : {}),
  };

  const res = await run(model, input, { onLog });
  const url = pickImage(res);
  const file = join(dir, 'takes', `${take}.png`);
  await download(url, file);

  await writeJSON(join(dir, 'takes', `${take}.json`), {
    take,
    kind: 'edit',
    model,
    prompt,
    // The provenance that matters: which image this was derived from. It is
    // what makes a look re-derivable when the default sheet changes, and what
    // stops anyone mistaking a derived look for an original.
    derivedFrom: from,
    input: { ...input, image_urls: ['<uploaded>'] },
    seed: res.seed ?? res.data?.seed ?? null,
    source: url,
    made_at: new Date().toISOString(),
    inputsHash: hash({ prompt, model, from, aspect, resolution, ...meta }),
    ...meta,
  });

  return { take, file };
}
