# Cast models — Esteban (Tripo bench, steps 1–2)

First end-to-end bipedal cast character through the Tripo pipeline:
text_to_model -> animate_prerigcheck -> animate_rig -> animate_retarget.

## Files

| file | what | size |
| --- | --- | --- |
| `esteban.glb` | static PBR model, shrunk textures | 0.39 MB |
| `esteban-rigged.glb` | skinned, 41-joint skeleton, no animation | 0.47 MB |
| `esteban-walk.glb` | rigged + `preset:walk` (2.38 s loop) | 0.59 MB |
| `esteban-idle.glb` | rigged + `preset:idle` (15.38 s loop) | 1.09 MB |
| `esteban-run.glb` | rigged + `preset:run` (1.29 s loop) | 0.55 MB |
| `src/*.glb` | pristine originals as downloaded (2048 px textures) | 0.83–1.53 MB |

Textures in the top-level copies were repacked with the shrink recipe from
`tools/shrink-assets.mjs` (base colour 512 px, normal/metallic-roughness 256 px,
JPEG q0.86). `src/` is untouched — regenerate the shrunk copies from there if
the budgets ever change.

## Provenance

- Generation task `9b6474f8-174e-4f2b-8ad7-b8519a42b321`, model v2.5-20250123,
  face_limit 10000 -> 9994 tris, 1 mesh, 1 material, 3 JPEG maps
  (base colour, metallic-roughness, normal).
- Prerigcheck: `riggable: true`, `rig_type: "avian"`, `topology: "avian"`.
- Rig task `bbb067b6-5f07-47b1-b18b-2088961dea87` (the id retargets bind to).
- First generation attempt was already upright-bipedal; no regeneration needed.
- Bounding box 0.68 x 0.80 x 1.00 m (w x h x d — the depth is mostly tail).

## Pose

Genuinely upright and bipedal: stands on two legs, chest out, head high,
wings articulated as arms in a wide spread A-pose (raised to just below
shoulder height, fully separate from the torso — no fusing). Copper-orange
plumage, red comb and wattle, gold beak and legs, dark green sickle tail,
matching the palette in `company/cast/esteban.js`.

## Skeleton (41 joints, humanoid biped; wings bound as arms)

```
Root
  Hip
    Pelvis
      L_Thigh > L_Calf > L_Foot > L_ToeBase
        (L_ThighTwist01/02 under Thigh, L_CalfTwist01/02 under Calf)
      R_Thigh > R_Calf > R_Foot > R_ToeBase
        (R_ThighTwist01/02, R_CalfTwist01/02)
    Waist
      Spine01 > Spine02
        NeckTwist01 > NeckTwist02 > Head
        L_Clavicle > L_Upperarm > L_Forearm > L_Hand
          (L_UpperarmTwist01/02, L_ForearmTwist01/02)
        R_Clavicle > R_Upperarm > R_Forearm > R_Hand
          (R_UpperarmTwist01/02, R_ForearmTwist01/02)
```

The wings are the Clavicle/Upperarm/Forearm/Hand chains, so any humanoid
retarget drives them as arms — exactly what the bipedal staging wants.

## Retarget presets

`preset:walk`, `preset:idle` and `preset:run` all exist and retarget cleanly
(each animation: 126 channels over the 41 joints). An invalid name is rejected
at submit time with code 1004 ("invalid animation name") but the error does
not enumerate the valid set, so further presets have to be probed by name.

## Gotchas

- Instancing any of the skinned GLBs needs `clone()` from
  `vendor/three/GLTFLoaderDeps.js`; `Object3D.clone` leaves the copy bound to
  the original bones.
- Not wired into the game yet — nothing imports these files.

## Step 2: the acting spike (engine/bone-actor.js + tools/bench-shot.mjs)

BoneActor extends Actor and swaps only the commit stage: the same channel
values (idle/emotion/look/gesture/jaw passes) are mapped onto the skeleton as
additive rotations about the CHARACTER's world axes, on top of an
AnimationMixer crossfading `preset:idle` and `preset:walk`. That world-axis
mapping is what makes it independent of Tripo's arbitrary bone rest
orientations. The face — eyes/lids/brows and the lip-sync beak — is the
procedural one from chicken.js, hung on a world-aligned anchor on the Head
bone over the painted face.

Model-space facts this depends on (from the GLBs, verified):

- The character faces +X in model space, wings along ±Z; the rig wrapper
  yaws it -90° to the cast's +Z convention.
- `preset:walk` bakes its root motion into the Hip translation track
  (~1.08 model-metres per 2.38 s loop ≈ 0.45 m/s); bone-actor strips the
  linear drift at load and matches the clip's timescale to the actor's real
  speed. `preset:idle` has no drift.
- Neck/head tracks are STRIPPED from both clips: the acting layer owns the
  head outright (as on the procedural rig), and each frame the neck/head
  bones are re-set to bind orientation in world space (rotated by the actor's
  yaw) before the channels are applied. Without this the idle clip's spine
  sway carries the head — and the face overlay — off wherever it likes.
- Face overlay calibration (baked defaults): faceUp 0.068, faceFwd 0.025,
  faceScale 1.15, eyeSpread 0.85, all tuned against renders; the painted eye
  line sits well above the Head bone origin.

The bench harness (tools/bench-shot.mjs) possesses the existing Esteban
in-place — Object.setPrototypeOf on the live Actor — so every closure the
Director captured at load keeps working. Pairs land in shots/bench/
(*-proc.png / *-tripo.png).

Known limits, honestly: feet still slide during turns and walk starts; the
painted tail/wattle/comb are rigid (no tailFan/tailPitch, no wattle spring);
puff has no body-scale equivalent; the accuse wing reads thinner than the
procedural paddle; and the model's baked-contrast albedo sits a touch darker
than the procedural cast under the night grade even with the 0.82 trim.
