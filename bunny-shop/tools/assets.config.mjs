// Every 3D asset in the game, and the prompt that produced it.
//
// The pipeline keys its ledger off these objects, so editing a prompt (or a
// face limit) marks that one asset stale and leaves the rest alone.

// Appended to every prompt so the shop reads as one set of objects rather than
// sixteen unrelated downloads.
const STYLE =
  'stylized cartoon game asset, soft rounded chunky shapes, warm storybook colours, ' +
  'clean readable silhouette, matte painted finish, no text, no lettering, ' +
  'single object, plain neutral background';

const NEGATIVE = 'photorealistic, gritty, text, letters, logo, watermark, cluttered, multiple objects, base plate, pedestal';

const asset = (name, prompt, opts = {}) => ({ name, prompt: `${prompt}, ${STYLE}`, negative: NEGATIVE, ...opts });

export const ASSETS = [
  // ---- customers -------------------------------------------------------
  // Cream/grey fur so the game can tint each customer a different colour.
  // A-pose with the limbs clear of the body is what makes auto-rigging work.
  asset(
    'bunny_round',
    'a cute chubby cartoon rabbit character standing upright on two hind legs in a wide A-pose with ' +
      'both arms held out away from the body and legs apart, plain cream-white fur, big round head, ' +
      'long soft floppy ears, round belly, short stubby arms, tiny round tail, large friendly eyes',
    { faces: 20000, rig: true, animations: ['idle', 'walk', 'jump', 'run', 'hurt'] },
  ),
  asset(
    'bunny_lanky',
    'a tall skinny cartoon rabbit character standing upright on two long hind legs in a wide A-pose with ' +
      'both arms held out away from the body and legs apart, plain light grey fur, narrow face, ' +
      'very long straight upright ears, gangly thin limbs, slight slouch, tired half-closed eyes',
    { faces: 20000, rig: true, animations: ['idle', 'walk', 'jump', 'run', 'hurt'] },
  ),

  // ---- the shop --------------------------------------------------------
  asset(
    'counter',
    'a small cosy wooden shop counter for a village grocery, warm honey-coloured planks, ' +
      'a rounded brass cash register sitting on top, front panel with simple carved trim',
    { faces: 14000 },
  ),
  asset(
    'shelf',
    'a rustic wooden market produce stand, three slanted open shelves, sturdy legs, ' +
      'warm painted wood, empty shelves with no produce on them',
    { faces: 12000 },
  ),
  asset('crate', 'a small open wooden crate, slatted sides, worn painted wood, empty', { faces: 6000 }),
  asset(
    'sign',
    'a hanging wooden shop sign shaped like a carrot, on a small curled iron bracket, painted orange and green',
    { faces: 6000 },
  ),
  asset(
    'plant',
    'a small potted leafy houseplant in a round terracotta pot, broad rounded leaves, cheerful',
    { faces: 6000 },
  ),
  asset('basket', 'a small round woven wicker shopping basket with a single arched handle, empty', { faces: 6000 }),
  asset('bell', 'a small brass service desk bell with a round dome and a press button on top', { faces: 4000 }),
  asset(
    'trenchcoat',
    'a long beige detective trench coat standing up on its own as if worn by someone invisible, ' +
      'buttoned front, wide collar, belt, empty hollow neck opening, no head, no person',
    { faces: 10000 },
  ),

  // ---- stock -----------------------------------------------------------
  asset('carrot', 'a single plump orange carrot with a leafy green top', { faces: 4000 }),
  asset('cabbage', 'a single round green cabbage with ruffled outer leaves', { faces: 4000 }),
  asset('strawberry', 'a single ripe red strawberry with a green leafy calyx', { faces: 4000 }),
  asset('corn', 'a single ear of yellow sweetcorn with the green husk peeled half back', { faces: 4000 }),
  asset('radish', 'a single round red radish with a white tip and small green leaves', { faces: 4000 }),
  asset('muffin', 'a single blueberry muffin in a fluted paper case, domed golden top', { faces: 4000 }),
];
