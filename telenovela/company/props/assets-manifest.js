// The generated props, produced by Tripo and repacked by tools/shrink-assets.mjs.
// Same shape as audio-manifest.js: paths in the module build, base64 data URIs
// in the bundle, so the single-file build carries its own set dressing.

export const ASSET_NAMES = [
  'fountain', 'bench', 'door', 'jug', 'pot-agave', 'bougainvillea',
  // The one useful survivor of the auto-rigging experiment: a skinned hen with
  // a walk clip, good enough for the far end of a dark courtyard.
  'hen-tripo-walk',
];

export const ASSETS = Object.fromEntries(ASSET_NAMES.map((n) => [n, `./company/props/assets/${n}.glb`]));
