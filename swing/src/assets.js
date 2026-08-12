// Asset resolution.
//
// Served from a folder, assets are ordinary relative paths. Bundled into a
// single file there is no folder to fetch from, so tools/bundle.mjs inlines each
// mesh as base64 and leaves the map on the global.
//
// The inlined path decodes to an ArrayBuffer and goes through the loader's
// parse() rather than its load(): a data: URI still has to be *fetched*, and a
// strict CSP with a `connect-src` that omits `data:` refuses it. That failure is
// silent — the meshes just never arrive — so the bundled build does no I/O at
// all and cannot be blocked.

const inlined = globalThis.__SKYLINE_ASSETS || {};

export const asset = (path) => inlined[path] || path;

function toArrayBuffer(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Load a .glb through `loader`, from disk or from the inlined bundle.
 * @param {{parseAsync: Function, loadAsync: Function}} loader a GLTFLoader
 * @param {string} path the same relative path used when serving a folder
 */
export async function loadGLB(loader, path) {
  const inline = inlined[path];
  if (!inline) return loader.loadAsync(path);
  const comma = inline.indexOf(',');
  return loader.parseAsync(toArrayBuffer(inline.slice(comma + 1)), '');
}
