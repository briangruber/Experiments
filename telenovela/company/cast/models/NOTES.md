# Cast models — the twins (hybrid cast, shipping)

The bench verdict was **hybrid**: the Tripo sculpt plays Esteban and Ricardo,
everyone else stays procedural (with the plumage upgrade in
`company/cast/plumage.js`). One skinned scene serves both twins — identical
twins, identical mesh, which is the plot point made literal — Ricardo gets the
blue/charcoal base-colour recolor swapped in at load. Zero Tripo API spend
beyond the original Esteban generation.

## Files

| file | what |
| --- | --- |
| `esteban-idle.glb` | skinned scene + 15.38 s idle clip, shrunk + graded (ships) |
| `esteban-walk.glb` | `preset:walk` clip, 2.38 s loop (ships; scene ignored) |
| `esteban-run.glb` | `preset:run` clip, 1.29 s loop (ships; blended in above walking speed) |
| `ricardo-body.jpg` | Ricardo's blue/charcoal recolor of the base colour (ships) |
| `esteban.glb`, `esteban-rigged.glb` | bench-era static/rigged copies, not bundled |
| `src/*.glb` | pristine originals as downloaded (2048 px textures) |

Shipping copies are regenerated from `src/` by **`tools/retexture-cast.mjs`**:
shrink (base 512 px, aux 256 px, JPEG q0.86) plus the offline grade — feathers
brightened and de-reddened toward the identity copper (0xb06a35 ratios), comb
kept red, and the sculpted beak texels flattened toward plumage so the painted
snout can never read as a second beak beside the overlay one. The same pass
cuts `ricardo-body.jpg` (true comb reds kept, everything else onto a
blue/charcoal ramp). Total shipping weight: **2.27 MB** (against the 4.5 MB
bound for added GLBs).

`company/cast/models-manifest.js` lists the shipping files; the bundler
replaces it with data: URIs. Loading is `engine/bone-actor.js` →
`buildTwinRigs`, wired in `company/cast/index.js` → `upgradeCast` (called from
main.js, `?proc-cast` disables), with the procedural cast as automatic
fallback if any byte fails to load.

## Provenance

- Generation task `9b6474f8-174e-4f2b-8ad7-b8519a42b321`, model v2.5-20250123,
  face_limit 10000 -> 9994 tris, 1 mesh, 1 material, 3 JPEG maps.
- Prerigcheck: `riggable: true`, `rig_type: "avian"`, `topology: "avian"`.
- Rig task `bbb067b6-5f07-47b1-b18b-2088961dea87` (the id retargets bind to).
- Bounding box 0.68 x 0.80 x 1.00 m (w x h x d — the depth is mostly tail).
- `preset:walk` / `preset:idle` / `preset:run` retarget cleanly; an invalid
  name is rejected with code 1004 without enumerating the valid set.

## Skeleton (41 joints, humanoid biped; wings bound as arms)

```
Root
  Hip
    Pelvis
      L_Thigh > L_Calf > L_Foot > L_ToeBase   (+twists)
      R_Thigh > R_Calf > R_Foot > R_ToeBase   (+twists)
    Waist
      Spine01 > Spine02
        NeckTwist01 > NeckTwist02 > Head
        L_Clavicle > L_Upperarm > L_Forearm > L_Hand   (+twists)
        R_Clavicle > R_Upperarm > R_Forearm > R_Hand   (+twists)
```

## How the twins act (engine/bone-actor.js)

BoneActor extends Actor and overrides ONLY `commitPose` — `buildPose`
(locomotion, emotion, idle, look, gestures, speech) is the shared pipeline.
Model-space facts this depends on, verified against the GLBs:

- The character faces +X in model space; the rig wrapper yaws it -90° to the
  cast's +Z convention and grounds it on the midpoint of the feet.
- Walk and run bake root motion into the Hip translation track; the drift is
  stripped at load and the clip timescale is ramped with the actor's real
  ground speed (idle→walk→run crossfade; turn rate clamped while stepping).
- Neck/head tracks are STRIPPED from all clips: the acting layer owns the head
  outright, restoring the bind orientation each frame before the channels.
- The Head bone is scaled up ×1.2 (CAL.headScale) — the bench found the CU
  carried too little face — with the overlay recalibrated to match:
  faceUp 0.085, faceFwd 0.035, faceScale 1.3, eyeSpread 0.92, beakScale 1.3
  (all in CAL, all tuned against rendered bench frames).
- The acting face is procedural over the painted head: a plumage skull SHELL
  (so brows and the far eye always sit on a surface off-profile), eyes, lids,
  clamped brows, sprung wattles, a crest ridge bridging the sculpted comb, and
  the enlarged beak that fully occludes the sculpted snout.
- Lost silhouette channels restored as overlays: tail fan on a Waist anchor
  (tailFan/tailPitch + spring), primary-feather fans on the Hand bones (the
  accuse/point/gasp area fix), puff as a small uniform Spine02 scale pulse.
- Close-ups get a warm short-throw fill (`attachCastFill`): a 1.6 m PointLight
  riding between the camera and the nearest skinned face, enabled only inside
  ~1.2 m — the fix for the near-black revelacion CU.

## Gotchas

- Instancing a skinned GLB needs `clone()` from
  `vendor/three/GLTFLoaderDeps.js`; `Object3D.clone` leaves the copy bound to
  the original bones (this bug shipped once already). Ricardo is such a clone,
  with materials cloned per-mesh before his map is swapped.
- Textures must load through `<img>` (`GLTFLoader.USE_IMAGE_BITMAP = false`)
  and bytes through the data-URI decoder — the published page blocks fetch().
- Metalness/roughness maps are dropped at load (roughness ≥ 0.82, metalness 0):
  feathers are not metal, and the baked speculars read as wet plastic.
