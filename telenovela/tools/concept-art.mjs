#!/usr/bin/env node
// Draw the character before you sculpt it.
//
//   node tools/concept-art.mjs esteban
//   node tools/concept-art.mjs --all
//   node tools/concept-art.mjs esteban --variants 3
//
// Tripo's text_to_model takes a sentence and guesses; image_to_model takes a
// picture and reconstructs it. The first route gave us a passable blob, and
// the difference is not subtle — so the cast now starts as concept art.
//
// What makes a reference image work as a 3D source, learned the hard way and
// baked into SHEET below: one subject, dead-on front, arms out so the wings
// are separated from the body (a wing tucked against the flank fuses to it in
// reconstruction), full body inside the frame including the feet, flat even
// light with no cast shadow to be mistaken for geometry, and a plain seamless
// backdrop. Everything dramatic — the night, the rain, the key light — is the
// renderer's job later, not the sculpt's.
//
// Images land in company/cast/concept/<key>.png and are committed: they are
// the provenance of the mesh, and regenerating a character means starting
// from the same picture rather than a new roll of the dice.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'company/cast/concept');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const MODEL = opt('model', 'openai/gpt-image-2');
const SIZE = opt('size', '1024x1024');
const VARIANTS = +opt('variants', 1);

// The parts of the prompt that are about being a usable 3D reference rather
// than about the character. Every sheet gets these.
const POSE = 'Full body, standing upright on two legs, facing the camera dead-on, '
  + 'symmetrical A-pose with both wings held out and away from the body so they '
  + 'read as separate arms, feet flat and fully visible, entire figure inside the frame '
  + 'with a margin of empty space on all sides.';
const LOOK = 'Character sheet for 3D modelling: flat even studio lighting from the front, '
  + 'no harsh shadows, no cast shadow on the floor, no rim light, plain seamless light grey '
  + 'background, no props, no text, no watermark, no border. '
  + 'Stylized-realistic animated feature film character, high detail feather grooming, '
  + 'expressive face with visible eyes and eyelids, clean silhouette.';

// The company, as a costume designer would brief them. Colour words are the
// ones the procedural specs use, so the sculpt and the fallback rig agree.
const SHEET = {
  esteban: 'An anthropomorphic rooster leading man, a telenovela galan. Rich copper-orange '
    + 'plumage with a warm golden sheen, a tall proud scarlet comb and wattles, golden-yellow '
    + 'beak and scaly yellow legs, long dark green iridescent sickle tail feathers arching behind him. '
    + 'Handsome confident face, strong brow, chest puffed out. He wears a red silk neckerchief '
    + 'knotted at his throat and a fitted short black matador-style jacket with gold braid, open at the chest.',
  ricardo: 'An anthropomorphic rooster villain, the evil identical twin brother. Steel blue and '
    + 'charcoal plumage with a cold sheen, scarlet comb and wattles with a scar across the comb, '
    + 'golden-yellow beak and yellow legs, near-black iridescent sickle tail feathers. '
    + 'A black leather eyepatch over one eye, a black silk neckerchief at his throat, '
    + 'and a dark charcoal jacket with black braid. Menacing, hard-eyed, same face as his brother.',
  rosalinda: 'An anthropomorphic hen leading lady, the innocent ingenue of a telenovela. '
    + 'Soft cream and ivory plumage, a small delicate rose-pink comb, warm golden beak and legs, '
    + 'large gentle amber eyes with long dark eyelashes. She wears a flowing wine-red ruffled '
    + 'flamenco-style dress with a gold belt and a gold pendant necklace, and a pink flower '
    + 'tucked behind one ear. Sweet, hopeful expression.',
  valentina: 'An anthropomorphic hen villainess of a telenovela. Near-black plumage with deep '
    + 'purple iridescence, a blood-red comb, dark slate beak, long dark eyelashes over sharp '
    + 'orange eyes, an arched cruel brow. She wears a black lace mantilla veil over her head, '
    + 'a fitted black lace gown with a high collar, and a single blood-red rose above one ear. '
    + 'Elegant, dangerous, faintly smiling.',
  donGallo: 'An anthropomorphic elderly rooster patriarch, the wealthy patron of a telenovela. '
    + 'Large and heavyset, slate grey and silver plumage going white at the neck, a dark red comb, '
    + 'pale horn-coloured beak, thick yellow legs. He wears a gold monocle on a chain over one eye, '
    + 'a brown wide-brimmed hat, and a burgundy waistcoat with a gold watch chain. '
    + 'Imperious, jowly, disapproving.',
  pollito: 'An anthropomorphic newborn chick, tiny and round, the size of a fist. Fluffy pale '
    + 'yellow down, oversized dark eyes, a tiny orange beak, tiny orange feet, one small curl of '
    + 'feather on top of its head. Standing upright, wings out to the sides. Innocent, wide-eyed, adorable.',
};

async function draw(key, prompt, index) {
  const res = await fetch('https://ai-gateway.vercel.sh/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, prompt, n: 1, size: SIZE }),
  });
  if (!res.ok) throw new Error(`${key}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error(`${key}: no image in response`);
  const name = index ? `${key}-${index + 1}.png` : `${key}.png`;
  const path = join(OUT, name);
  await writeFile(path, Buffer.from(b64, 'base64'));
  const kb = (Buffer.from(b64, 'base64').length / 1024).toFixed(0);
  console.log(`  ${name}  ${kb} KB`);
  return path;
}

const keys = args.includes('--all')
  ? Object.keys(SHEET)
  : args.filter((a) => !a.startsWith('--') && SHEET[a]);
if (!keys.length) {
  console.error(`usage: node tools/concept-art.mjs <${Object.keys(SHEET).join('|')}|--all>`);
  process.exit(1);
}
if (!process.env.AI_GATEWAY_API_KEY) { console.error('AI_GATEWAY_API_KEY not set'); process.exit(1); }

await mkdir(OUT, { recursive: true });
for (const key of keys) {
  const prompt = `${SHEET[key]}\n\n${POSE}\n\n${LOOK}`;
  for (let i = 0; i < VARIANTS; i++) {
    await draw(key, prompt, VARIANTS > 1 ? i : 0);
  }
}
console.log(`\nconcept art in company/cast/concept/`);
