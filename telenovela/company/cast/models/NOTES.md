# Cast models — the sculpted company

Five of the six leads ship as Tripo sculpts. Pollito stays procedural: his
comedy is squash, puff and a head that doubles in size, none of which a fixed
skeleton does.

## How a character is made

The first cast was `text_to_model` — a sentence, and Tripo guessing. It came
back passable and blobby, with a painted face that could not hold a key light.
The route now is the one a character actually deserves:

```
tools/concept-art.mjs <key>     # gpt-image-2 paints the character sheet
tools/tripo.mjs model <key>     # image_to_model, v3.0, from that painting
tools/tripo.mjs rig <key>       # prerigcheck, then a 41-joint humanoid bind
tools/tripo.mjs anim <key> walk idle run
tools/bake-cast.mjs             # src/ -> the files that ship
```

The concept art is committed in `company/cast/concept/` because it is the
provenance of the mesh: regenerating a character means going back to the same
picture, not rolling the dice on a new sentence. It is also where the costume
comes from — the flamenco ruffles, the lace mantilla and the monocle are
geometry in the sculpt because they were painted before anything was sculpted,
which is why the wardrobe overlays those characters used to need are gone.

## Files

| file | what |
| --- | --- |
| `esteban.glb` | el galán — and, recoloured, his brother |
| `rosalinda.glb` | la inocente |
| `valentina.glb` | la villana |
| `don-gallo.glb` | el patrón |
| `anim-idle.glb` | 15.4 s idle, tracks only |
| `anim-walk.glb` | walk cycle, root drift stripped at load |
| `anim-run.glb` | run cycle, blended in above walking speed |
| `ricardo-body.jpg` | Ricardo's blue/charcoal recolor of Esteban's map |
| `src/*.glb` | pristine downloads, 4096 px maps — never shipped |
| `src/v25/*.glb` | the superseded text_to_model cast, kept for the A/B |

Ricardo is not a fifth generation: he reuses Esteban's skinned scene with the
recoloured map swapped in at load. Identical twins are a plot point, and a
shared mesh makes it literal.

## Where the budget went

A Tripo retarget ships as a whole second copy of the character — mesh,
skeleton and three 4096 px maps, 3.3 MB to carry 2.4 s of rotation curves —
and every character comes back on the same 41-joint skeleton with the same
bone names. So `bake-cast.mjs` strips each retarget to its curves and the
whole cast shares one set. Within a clip it also drops every scale track
(bones do not scale) and every translation track but the root's (a joint is
fixed to its parent; the rest restate the bind offset once per frame).

On the meshes: base colour to 512 px and normal to 256 px, the
metallic-roughness map dropped entirely with metalness forced to 0 and
roughness to 0.85 — the raw bake is wet-looking plastic under a key light.
Then the vertex attributes narrow under `KHR_mesh_quantization`: normals to
signed bytes (a unit vector does not need 32-bit floats), UVs to normalized
shorts, skin weights to normalized bytes with the rounding error handed to the
largest weight so every vertex still sums to exactly 1.

| | raw | shipped |
| --- | --- | --- |
| four sculpts | 12.6 MB | 2.2 MB |
| three clips | 10.4 MB | 0.37 MB |

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

`animate_prerigcheck` labels the topology `biped` for some birds and `avian`
for others, and it makes no difference: both come back on the skeleton above,
which is what lets one walk cycle fit the company.

## Provenance

Every task id is in `provenance.json`, written by `tools/tripo.mjs` as it goes:
which concept painting a mesh came from, which generation a rig was bound to,
and which rig a clip was retargeted from. `v3.0-20250812` is the newest model
version the API accepts — the studio's v3.1 is not exposed, and every `v3.1-*`
string is rejected with code 2017.
