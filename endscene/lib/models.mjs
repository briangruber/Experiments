// Which models are on offer, and what they actually cost today.
//
// Prices here are never hardcoded. fal publishes a `pricingInfoOverride` string
// per model through https://fal.ai/api/models, maintained by them, and that is
// what the UI shows. A price baked into source is wrong the first week someone
// changes it, and wrong silently — which is the worst way for a tool that
// spends money on your behalf to be wrong.
//
// The registry below is a curated shortlist rather than the whole catalogue.
// fal hosts hundreds of models and a picker with hundreds of entries is not a
// choice, it is an obstacle. These are the ones worth putting in front of
// someone building a show.

import { readJSON, writeJSON, exists } from './store.mjs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// The shortlist
// ---------------------------------------------------------------------------

export const EDIT_MODELS = [
  {
    id: 'fal-ai/nano-banana-2/edit',
    label: 'Nano Banana 2',
    lab: 'Google',
    note: 'Best quality for the money. The default, and what the wardrobe rule was proven against.',
    recommended: true,
  },
  {
    id: 'bytedance/seedream/v5/pro/edit',
    label: 'Seedream 5 Pro',
    lab: 'Bytedance',
    note: 'Same lab as Seedance 2.5, so its output may sit more naturally with the video model. Newer, less proven.',
  },
  {
    id: 'fal-ai/flux-2-pro/edit',
    label: 'FLUX.2 Pro',
    lab: 'Black Forest Labs',
    note: 'Strong at localised edits that leave the rest of the frame alone. Priced per megapixel.',
  },
  { id: 'fal-ai/nano-banana-pro/edit', label: 'Nano Banana Pro', lab: 'Google', note: 'The 4K sibling. Worth it for hero art, wasteful for a reference sheet.' },
  { id: 'xai/grok-imagine-image/edit', label: 'Grok Imagine', lab: 'xAI', note: 'Cheapest on the list by some way.' },
  { id: 'openai/gpt-image-2/edit', label: 'GPT Image 2', lab: 'OpenAI', note: 'Token-priced, so cost varies with the quality setting.' },
];

export const IMAGE_MODELS = [
  { id: 'fal-ai/nano-banana-2', label: 'Nano Banana 2', lab: 'Google', recommended: true, note: 'Consistent with the editor, which matters when a look is edited later.' },
  { id: 'bytedance/seedream/v5/pro', label: 'Seedream 5 Pro', lab: 'Bytedance', note: 'Same lab as the video model.' },
  { id: 'fal-ai/flux-2-pro', label: 'FLUX.2 Pro', lab: 'Black Forest Labs' },
  { id: 'openai/gpt-image-2', label: 'GPT Image 2', lab: 'OpenAI', note: 'What the original character sheets were drawn with.' },
];

export const VIDEO_MODELS = [
  {
    id: 'bytedance/seedance-2.5/reference-to-video',
    label: 'Seedance 2.5',
    lab: 'Bytedance',
    recommended: true,
    note: 'Up to 30 image, 10 video and 10 audio references, 4–30s, synchronised audio. No seed.',
  },
];

const ALL = [...EDIT_MODELS, ...IMAGE_MODELS, ...VIDEO_MODELS];
export const findModel = (id) => ALL.find((m) => m.id === id);

// ---------------------------------------------------------------------------
// Live pricing
// ---------------------------------------------------------------------------

// fal's search is by keyword, not by id, so the last path segment is a poor
// query — `edit` matches everything. The family name is what actually finds a
// model, so query on that and match the id exactly out of the results.
const queryFor = (id) => {
  const parts = id.split('/').filter((p) => !['fal-ai', 'edit', 'pro', 'reference-to-video'].includes(p));
  return parts[parts.length - 1] || id;
};

async function fetchPricing(id) {
  const url = `https://fal.ai/api/models?query=${encodeURIComponent(queryFor(id))}&page_size=40`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fal models ${res.status}`);
  const { items = [] } = await res.json();
  const hit = items.find((m) => m.id === id);
  if (!hit) return null;
  return {
    id,
    // Stripped of markdown emphasis: it renders as plain text in the UI and in
    // a terminal, and fal's copy is liberally bolded.
    pricing: (hit.pricingInfoOverride || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim() || null,
    title: hit.title,
    lab: hit.modelLab,
    thumbnail: hit.thumbnailUrl,
    updated: hit.date,
  };
}

// Cached to disk, because this is called on every page load of the model
// picker and fal's answer changes about as often as their pricing page does.
// A day is generous for how fast that moves and short enough to catch a change
// before it costs anyone real money.
const TTL_MS = 24 * 60 * 60 * 1000;

export async function pricing(ids, { cacheDir, force = false } = {}) {
  const cachePath = cacheDir ? join(cacheDir, 'pricing.json') : null;
  const cache = cachePath && (await exists(cachePath)) ? await readJSON(cachePath, {}) : {};
  const now = Date.now();
  const out = {};
  let dirty = false;

  for (const id of ids) {
    const hit = cache[id];
    if (!force && hit && now - hit.fetchedAt < TTL_MS) {
      out[id] = hit;
      continue;
    }
    try {
      const fresh = await fetchPricing(id);
      out[id] = { ...(fresh || { id, pricing: null }), fetchedAt: now };
      cache[id] = out[id];
      dirty = true;
    } catch {
      // A pricing lookup failing must never stop someone working. Fall back to
      // whatever was last known and mark it, rather than blocking the picker.
      out[id] = hit ? { ...hit, staleCache: true } : { id, pricing: null, unavailable: true };
    }
  }

  if (dirty && cachePath) await writeJSON(cachePath, cache);
  return out;
}

// ---------------------------------------------------------------------------
// Estimating a shoot
// ---------------------------------------------------------------------------
//
// Seedance's published rates, used only to show a number before the money is
// spent. Deliberately approximate and labelled as such in the UI — fal bills on
// tokens, and a video reference is billed for its own input seconds too.

const VIDEO_RATE = {
  '720p': { plain: 0.4730, withVideoRef: 0.2838 },
  '480p': { plain: 0.2205, withVideoRef: 0.1323 },
};

export function estimateShot({ seconds, resolution = '720p', videoRefSeconds = 0 }) {
  const rate = VIDEO_RATE[resolution] || VIDEO_RATE['720p'];
  const hasRef = videoRefSeconds > 0;
  const perSecond = hasRef ? rate.withVideoRef : rate.plain;
  // Input video seconds are billed as well as the output.
  return (Number(seconds) + videoRefSeconds) * perSecond;
}

export function estimateScene(shots, { resolution = '720p' } = {}) {
  let total = 0;
  const rows = shots.map((s) => {
    const videoRefSeconds = (s.videos?.length || 0) * Number(s.duration || 0);
    const cost = estimateShot({ seconds: s.duration, resolution, videoRefSeconds });
    total += cost;
    return { id: s.id, slate: s.slate, seconds: Number(s.duration), videoRefSeconds, cost };
  });
  return { rows, total, resolution };
}
