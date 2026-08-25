# Original water-detail assets

These assets were generated specifically for Abyssal Ocean on 2026-08-18.
They do not contain files copied from Three.js Water Pro or another water
package.

- `foam-lace.png` — a seamless, histogram-balanced monochrome mask. The shader
  thresholds it against physically computed foam coverage, so it adds bubble
  holes and filament edges without inventing foam.
- `wake-foam-coarse.png`, `wake-foam-fine.png`, `wake-foam-breakup.png` —
  independent, non-centred wake masks. Their opposite edges are blended over a
  narrow border so the random interior remains intact without a visible seam.
- `wake-foam-pack.png` — the three wake masks packed into R/G/B. The shader
  reads it once in a rotated, unrelated UV frame and uses wake energy as age:
  dense transom suds, cellular mid-trail, then sparse breakup.
- `splash-atlas.png` — eight monochrome water-impact plates on black. The spray
  shader reads luminance as opacity only for hull-impact parcels.

Generation prompts asked for original, unbranded overhead ocean-foam lace and
an original 4-by-2 set of orthographic water-impact silhouettes. The results
were converted to grayscale and losslessly optimized. Run
`node tools/embed-water-assets.mjs` after changing any packed PNG so the
self-contained demo bundle receives the same bytes.
