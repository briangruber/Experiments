// Minimal client for the Tripo v3 OpenAPI.
//
// Only the four calls DEADLIGHT needs: text-to-model, auto-rig, animation
// retarget, and task polling. Every generation is billed, so the caller is
// expected to layer a cache on top (see state.mjs) — this module deliberately
// has no memory of its own.

import { writeFile } from 'node:fs/promises';

const BASE = 'https://openapi.tripo3d.ai/v3';

/** Model versions, pinned so a re-run months from now produces the same set. */
export const TEXT_MODEL = 'v3.1-20260211';
export const RIG_MODEL = 'v2.5-20260210';

function key() {
  const k = process.env.TRIPO_API_KEY;
  if (!k) throw new Error('TRIPO_API_KEY is not set');
  return k;
}

/**
 * A POST/GET against the API with retry on the failures that are worth
 * retrying: network resets, 429, and 5xx. A 4xx other than 429 is a bad
 * request and retrying it just burns time, so it throws immediately.
 */
async function call(path, { method = 'GET', body } = {}, attempt = 0) {
  let res, text;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key()}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    text = await res.text();
  } catch (err) {
    if (attempt >= 4) throw err;
    await sleep(2000 * 2 ** attempt);
    return call(path, { method, body }, attempt + 1);
  }

  const retryable = res.status === 429 || res.status >= 500;
  if (retryable && attempt < 4) {
    await sleep(2000 * 2 ** attempt);
    return call(path, { method, body }, attempt + 1);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok || json.code !== 0) {
    throw new Error(
      `${method} ${path} → ${res.status} code=${json.code}: ${json.message || text.slice(0, 300)}`,
    );
  }
  return json.data;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Submit a text-to-model job. Returns a task id. */
export async function textToModel(prompt, { faceLimit = 8000 } = {}) {
  const data = await call('/generation/text-to-model', {
    method: 'POST',
    body: {
      prompt,
      model: TEXT_MODEL,
      face_limit: faceLimit,
      texture: true,
      pbr: true,
      texture_quality: 'standard',
    },
  });
  return data.task_id;
}

/** Auto-rig a finished mesh task as a biped. Returns a task id. */
export async function rig(modelTaskId, { rigType = 'biped', model = RIG_MODEL } = {}) {
  const data = await call('/animations/rig', {
    method: 'POST',
    body: {
      input: modelTaskId,
      model,
      rig_type: rigType,
      spec: 'mixamo',
      out_format: 'glb',
    },
  });
  return data.task_id;
}

/**
 * Retarget preset animations onto a rigged task.
 *
 * `presets` may be one id or several. Passing several in one call is the
 * cheap path, but the API returns whatever it returns — the caller must be
 * ready for either one multi-clip GLB or a list of single-clip ones, so
 * `pollTask` output is handed back untouched.
 */
export async function retarget(rigTaskId, presets, { withGeometry = true } = {}) {
  const list = Array.isArray(presets) ? presets : [presets];
  const data = await call('/animations/retarget', {
    method: 'POST',
    body: {
      input: rigTaskId,
      ...(list.length === 1 ? { animation: list[0] } : { animations: list }),
      out_format: 'glb',
      bake_animation: true,
      export_with_geometry: withGeometry,
    },
  });
  return data.task_id;
}

/**
 * Poll a task to a terminal state. Tripo jobs run 2–5 minutes, so this is
 * slow by nature; `onProgress` exists so a long run still prints something.
 */
export async function pollTask(taskId, { onProgress, intervalMs = 5000, timeoutMs = 25 * 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  for (;;) {
    const data = await call(`/tasks/${taskId}`);
    if (onProgress && data.progress !== last) {
      last = data.progress;
      onProgress(data.status, data.progress ?? 0);
    }
    if (data.status === 'success') return data;
    if (['failed', 'cancelled', 'banned', 'expired', 'unknown'].includes(data.status)) {
      throw new Error(`task ${taskId} ended as "${data.status}"`);
    }
    if (Date.now() > deadline) throw new Error(`task ${taskId} timed out`);
    await sleep(intervalMs);
  }
}

/**
 * Pull every model URL out of a finished task. Retarget tasks may report a
 * single `model_url` or a list under `animations`/`models`, so all the shapes
 * seen in the wild are flattened here rather than at each call site.
 */
export function modelUrls(output = {}) {
  const urls = [];
  const push = (u, name) => u && urls.push({ url: u, name });

  push(output.model_url, output.animation || null);
  push(output.pbr_model, null);
  for (const list of [output.animations, output.models, output.outputs]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry === 'string') push(entry, null);
      else push(entry.model_url || entry.url, entry.animation || entry.name || null);
    }
  }
  // De-duplicate: some responses repeat the same URL in two fields.
  const seen = new Set();
  return urls.filter(({ url }) => !seen.has(url) && seen.add(url));
}

/** Download a signed model URL to disk. */
export async function download(url, dest, attempt = 0) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download → ${res.status}`);
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    if (attempt >= 4) throw err;
    await sleep(2000 * 2 ** attempt);
    return download(url, dest, attempt + 1);
  }
}
