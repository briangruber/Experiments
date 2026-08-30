// The fal call, and the style the project generates in.
//
// Both generators — the backdrop and the props — have to paint in the same
// hand, so the style is a committed project setting (style.json) rather than a
// flag someone has to remember on the command line. Change it once and the
// next regeneration of anything comes out matching.
//
// A style LoRA is the piece that makes room two through room forty cheap. With
// it, "painterly" stops being a word in a prompt that the model interprets
// afresh every run, and becomes a fixed set of weights. Without it, every
// generation is an independent roll: this prototype's tavern sign has come back
// reading "Jeavern", "TÉRA" and "TAVERN" across three runs of the same prompt.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './harness.mjs';

const KEY = () => process.env.FAL_KEY;
const headers = () => ({ Authorization: `Key ${KEY()}`, 'content-type': 'application/json' });

export async function loadStyle() {
  const path = join(ROOT, 'style.json');
  try { await stat(path); } catch { return { lora: null }; }
  const s = JSON.parse(await readFile(path, 'utf8'));
  return { scale: 1, trigger: '', ...s };
}

// Civitai answers 401 to an unauthenticated download, so fal cannot fetch one
// of its URLs the way it fetches a Hugging Face one. A free token appended as a
// query parameter is the whole difference, and it keeps the token out of
// style.json — that file is committed.
export function resolveLora(url) {
  if (!url) return null;
  if (!/civitai\.com/.test(url)) return url;
  const token = process.env.CIVITAI_TOKEN;
  if (!token) {
    throw new Error(
      'style.json points at a Civitai LoRA but CIVITAI_TOKEN is not set.\n'
      + '  Civitai returns 401 to anonymous downloads, so fal cannot fetch it either.\n'
      + '  Create a free token at civitai.com/user/account and export CIVITAI_TOKEN.',
    );
  }
  return url + (url.includes('?') ? '&' : '?') + 'token=' + token;
}

export async function falRun(model, input, label) {
  if (!KEY()) throw new Error('FAL_KEY not set');
  const submit = await fetch(`https://queue.fal.run/${model}`, {
    method: 'POST', headers: headers(), body: JSON.stringify(input),
  });
  const queued = await submit.json();
  if (!submit.ok) throw new Error(`${label} submit ${submit.status}: ${JSON.stringify(queued).slice(0, 500)}`);
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await (await fetch(queued.status_url, { headers: headers() })).json();
    if (st.status === 'COMPLETED') return (await fetch(queued.response_url, { headers: headers() })).json();
    if (st.status === 'FAILED') throw new Error(`${label} failed: ${JSON.stringify(st).slice(0, 500)}`);
    if (i % 6 === 0) console.log(`  ${label}: ${st.status}...`);
  }
  throw new Error(`${label} timed out`);
}

// One repaint, with or without a style LoRA. The LoRA route is a different
// endpoint, so the choice is made here rather than at each call site.
export async function repaint({ style, imageUrl, prompt, strength, width, height, label, steps = 40 }) {
  const lora = resolveLora(style.lora);
  const model = lora ? 'fal-ai/flux-lora/image-to-image' : 'fal-ai/flux/dev/image-to-image';
  const input = {
    image_url: imageUrl,
    // The trigger word is what actually activates the trained weights; a LoRA
    // with its trigger left out of the prompt is a LoRA that does nothing.
    prompt: style.trigger ? `${style.trigger}. ${prompt}` : prompt,
    strength,
    num_inference_steps: steps,
    guidance_scale: 3.5,
    num_images: 1,
    enable_safety_checker: false,
    output_format: 'png',
  };
  if (lora) {
    input.loras = [{ path: lora, scale: style.scale ?? 1 }];
    // flux-lora/image-to-image does not infer the output size from the input,
    // and a reframed plate is exactly what the blockout exists to prevent.
    if (width && height) input.image_size = { width, height };
  }
  const out = await falRun(model, input, label);
  const img = out.images?.[0];
  if (!img?.url) throw new Error(`${label}: no image returned — ${JSON.stringify(out).slice(0, 300)}`);
  return { url: img.url, width: img.width, height: img.height, model, lora: style.lora || null };
}

export const fetchBuf = async (url) => Buffer.from(await (await fetch(url)).arrayBuffer());
export const toDataUri = (buf, mime = 'image/png') => `data:${mime};base64,${buf.toString('base64')}`;
