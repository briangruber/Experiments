// Hero assets: the few generated GLB models that carry identity — the tavern,
// the dolphin, soon the fisher. Everything else in the game stays procedural;
// these exist because a character and a landmark live or die on silhouette,
// and silhouette is the one thing kit-bashed boxes cannot buy.
//
// Two paths to the same bytes:
//   dev      fetch('assets/name.glb') off the static server
//   bundled  window.__SF_ASSETS[name], base64 baked into the single HTML by
//            tools/bundle.mjs — the Artifact host blocks every external
//            request, so there is nothing to fetch from
//
// Parsing goes through three's own GLTFLoader (vendored, examples r185). A
// missing or corrupt asset resolves to null rather than throwing: the callers
// all have a procedural fallback, and a hero asset that fails to load should
// degrade to yesterday's game, not to a black screen.

import { GLTFLoader } from '../../vendor/three/GLTFLoader.js';

function fromB64(b64) {
  const bin = atob(b64);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a.buffer;
}

/** Raw GLB bytes for `name`, from the bundle if present, else the network. */
async function rawGlb(name) {
  if (typeof window !== 'undefined' && window.__SF_ASSETS && window.__SF_ASSETS[name]) {
    return fromB64(window.__SF_ASSETS[name]);
  }
  const r = await fetch('assets/' + name + '.glb');
  if (!r.ok) throw new Error('asset ' + name + ': ' + r.status);
  return r.arrayBuffer();
}

/**
 * Load and parse one hero asset. Resolves to the GLTF result ({ scene,
 * animations, ... }) or null. Never rejects.
 */
export async function loadGlb(name) {
  try {
    const buf = await rawGlb(name);
    return await new GLTFLoader().parseAsync(buf, '');
  } catch (err) {
    console.warn('hero asset "' + name + '" unavailable:', err && err.message);
    return null;
  }
}
