// The standing marks: where people stand in the courtyard, named once and
// shared by every scene of the episode. A scene gets these through its build()
// deps rather than importing them, so the scene modules stay plain data plus
// closures with no imports of their own.

import { V } from '../../engine/director.js';

export const MARKS = {
  BY_FOUNTAIN: V(-0.75, 0, 0.35),
  CENTRE: V(0.2, 0, -0.55),
  HER_MARK: V(-0.55, 0, 0.15),
  HIS_MARK: V(0.75, 0, -0.15),
  HIDE_PALM: V(2.25, 0, 1.95),
  ARCH_IN: V(0, 0, -2.6),
  ARCH_L: V(-2.35, 0, -2.7),
  // Offstage: the dark room behind the arches. The back wall spans z -3.7..-3.2,
  // so anyone placed at -3.5 is standing inside it and appears to pop into
  // existence the moment the scene cuts.
  OFF_CENTRE: V(0, 0, -4.45),
  OFF_LEFT: V(-2.35, 0, -4.3),
};
