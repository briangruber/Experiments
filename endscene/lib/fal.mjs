// A small fal.ai client: put a file somewhere the model can see it, and run a
// queued model to completion.
//
// No SDK. The queue protocol is three URLs and a poll loop, and writing it out
// means the failure modes are visible — which matters here, because a video
// generation that dies twenty seconds in still costs the same as one that
// works, and you want to read the error rather than watch a spinner.

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const KEY = process.env.FAL_KEY;
const auth = () => {
  if (!KEY) throw new Error('FAL_KEY is not set');
  return { Authorization: `Key ${KEY}` };
};

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

// Two-step upload: ask for a signed slot, then PUT the bytes into it. The
// returned file_url is the one to hand the model — the upload_url carries a
// signature and expires.
export async function upload(path) {
  const body = await readFile(path);
  const name = basename(path);
  const type = MIME[extname(path).toLowerCase()] || 'application/octet-stream';

  const init = await fetch(
    'https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3',
    {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ content_type: type, file_name: name }),
    },
  );
  if (!init.ok) throw new Error(`upload initiate ${init.status}: ${(await init.text()).slice(0, 300)}`);
  const { file_url, upload_url } = await init.json();

  const put = await fetch(upload_url, {
    method: 'PUT',
    headers: { 'content-type': type },
    body,
  });
  if (!put.ok) throw new Error(`upload PUT ${put.status}: ${(await put.text()).slice(0, 300)}`);
  return file_url;
}

// Submit to the queue and poll until it settles. `onLog` gets each new log
// line once, so a long generation prints progress instead of going quiet.
export async function run(endpoint, input, { onLog, pollMs = 3000, timeoutMs = 20 * 60_000 } = {}) {
  const base = `https://queue.fal.run/${endpoint}`;
  const submit = await fetch(base, {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!submit.ok) throw new Error(`submit ${submit.status}: ${(await submit.text()).slice(0, 600)}`);
  const { request_id } = await submit.json();

  // The status and result URLs hang off the model's root, not the sub-path:
  // for `a/b/c` the queue lives at `a/b`. Deriving it from the endpoint keeps
  // this honest if the endpoint ever moves.
  const root = endpoint.split('/').slice(0, -1).join('/');
  const statusUrl = `https://queue.fal.run/${root}/requests/${request_id}/status?logs=1`;
  const resultUrl = `https://queue.fal.run/${root}/requests/${request_id}`;

  const started = Date.now();
  let seen = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    const res = await fetch(statusUrl, { headers: auth() });
    if (!res.ok) throw new Error(`status ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const st = await res.json();

    for (const log of (st.logs || []).slice(seen)) onLog?.(log.message);
    seen = (st.logs || []).length;

    if (st.status === 'COMPLETED') {
      const out = await fetch(resultUrl, { headers: auth() });
      if (!out.ok) throw new Error(`result ${out.status}: ${(await out.text()).slice(0, 600)}`);
      return out.json();
    }
    // The queue reports a failed request as a terminal status rather than an
    // HTTP error, so an unchecked poll loop would spin here forever.
    if (st.status === 'FAILED' || st.status === 'ERROR') {
      throw new Error(`generation failed: ${JSON.stringify(st).slice(0, 600)}`);
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms (request ${request_id})`);
  }
}

export async function download(url, path) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status} ${url}`);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, Buffer.from(await res.arrayBuffer()));
  return path;
}
