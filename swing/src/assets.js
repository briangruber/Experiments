// Asset resolution.
//
// Served from a folder, assets are ordinary relative paths. Bundled into a
// single file there is no folder to fetch from, so tools/bundle.mjs inlines each
// mesh as a data URI and leaves the map on the global. Both loaders go through
// here, so neither has to know which mode it is running in.

const inlined = globalThis.__SKYLINE_ASSETS || {};

export const asset = (path) => inlined[path] || path;
