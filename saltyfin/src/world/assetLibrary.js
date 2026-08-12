// The prop library — every generated GLB the editor can place, described.
//
// Each entry is the complete contract between the three parties that touch a
// library asset: the loader (which fetches assets/lib-<name>.glb), the town
// (which scales it to `size`, stands it on the deck, and pushes a `fp` solid
// under it), and the editor (which shows `label`, filters on `tags`, and
// draws the thumbnail from assetThumbs.js).
//
// `size` is metres along `axis`: 'y' fits a thing by its height (a torch, a
// palm), 'xz' by its footprint's longest side (a rowboat is long and low —
// scaling one by height makes a cartoon). The generator dreams at whatever
// scale it likes; measuring and fitting here is what keeps a parasol from
// towering over the tavern.
//
// Adding an asset is three steps, all data: generate the GLB into
// assets/lib-<name>.glb, add the entry here, regenerate assetThumbs.js. The
// town and the editor pick it up from this table; nothing else changes.

export const LIBRARY = {
  umbrella: { label: 'Market Umbrella', tags: 'parasol shade stripes stall', size: 2.6, axis: 'y', fp: 1.1 },
  dinghy: { label: 'Rowboat', tags: 'boat dinghy skiff oars wooden', size: 3.2, axis: 'xz', fp: 1.6 },
  // Asked for lobster traps; the generator dreamt a stack of painted crates
  // with little beach scenes on the panels. It is charming, so it stays --
  // named for what it IS, because a library lies at its peril.
  traps: { label: 'Painted Crates', tags: 'crate stack painted pictures', size: 1.1, axis: 'xz', fp: 0.7 },
  netrack: { label: 'Drying Rack', tags: 'fish net hanging line wooden', size: 2.0, axis: 'y', fp: 1.0 },
  anchor: { label: 'Old Anchor', tags: 'iron ship rope nautical', size: 1.6, axis: 'y', fp: 0.6 },
  ropecoil: { label: 'Rope Coil', tags: 'line mooring dock nautical', size: 0.9, axis: 'xz', fp: 0.55 },
  torch: { label: 'Tiki Torch', tags: 'flame fire light bamboo night', size: 2.2, axis: 'y', fp: 0.35 },
  palm: { label: 'Potted Palm', tags: 'tree plant pot green tropical', size: 3.0, axis: 'y', fp: 0.8 },
};

/** Asset names in display order. */
export const LIBRARY_NAMES = Object.keys(LIBRARY);
