// Every tunable in one place. `ui.js` builds the panel from this, the shaders
// read it as uniforms, and "Copy params" on the panel dumps the current values
// as JSON so a tuning session can be pasted straight back into a conversation.
//
// min/max/step are for the slider; `v` is the live value.

export const PARAMS = {
  boat: {
    // Negative is ASTERN, and the slider goes there because the throttle keys
    // ride the slider: with a floor of 0 holding Down parked her at a stop and
    // there was no way back past it short of the separate S key.
    speed:        { v: 4.1545, min: -8,  max: 100,  step: 0.1,  label: 'Speed (m/s)' },
    turnRate:     { v: 0,  min: -25, max: 25,  step: 0.5,  label: 'Turn (°/s)' },
    accel:        { v: 5.3, min: 0.1, max: 12,  step: 0.05, label: 'Acceleration (m/s²)' },
    brake:        { v: 1.9, min: 1,   max: 8,   step: 0.1,  label: 'Braking x accel' },
    astern:       { v: 2.4, min: 0,   max: 8,   step: 0.1,  label: 'Astern speed (m/s)' },
    steerRate:    { v: 26, min: 2,   max: 90,  step: 1,    label: 'Steer rate (°/s)' },
    hardTurn:     { v: 2.4, min: 1,   max: 5,   step: 0.05, label: 'Shift turn ×' },
    // The same key, on the other axis. Shift already meant a harder turn and
    // meant nothing on the throttle, so it was a modifier one way and dead the
    // other.
    hardThrottle: { v: 3,   min: 1,   max: 8,   step: 0.1,  label: 'Shift throttle ×' },
    throttleRate: { v: 7, min: 0.5, max: 30,  step: 0.5,  label: 'Throttle rate (m/s²)' },
    humpFroude:   { v: 0.95, min: 0.3, max: 2,   step: 0.01, label: 'Hump Froude no.' },
    trimRest:     { v: 1.2,  min: 0,   max: 6,   step: 0.1,  label: 'Bow-down at rest (°)' },
    trimHump:     { v: 8,  min: 0,   max: 15,  step: 0.1,  label: 'Trim at hump (°)' },
    trimPlane:    { v: 4,  min: 0,   max: 12,  step: 0.1,  label: 'Trim on plane (°)' },
    riseMax:      { v: 0.88, min: 0,   max: 2,   step: 0.01, label: 'Hull rise (m)' },
    // HOW FAR SHE MAY TRIM, AS A MULTIPLE OF HER DRAFT.
    //
    // A hull cannot trim further than its draft allows: past the angle where
    // the forefoot lifts clear she is not trimming, she is leaving. The trim
    // curve above was authored for a 9.9 m hull and the pivot lever is the
    // DRAWN length -- 23.8 m at model scale 2.4 -- so the same angle throws the
    // ends 2.4x further, while draft does not scale with model scale at all.
    // Measured at eight metres a second before this went in: bow 1.44 m clear,
    // stern 1.73 m under, a one-and-a-half-metre see-saw.
    //
    // 1 keeps the forefoot exactly at the surface at full trim. Above that she
    // lifts her bow clear, which is real at speed -- and the wake is then laid
    // from where the keel actually meets the water, not from the stem.
    trimRoom:     { v: 1.1,  min: 0.2, max: 4,   step: 0.05, label: 'Trim room (x draft)' },
    wetShift:     { v: 0.52, min: 0,   max: 0.9, step: 0.01, label: 'Contact point aft' },
    planing:      { v: 6.5, min: 0.5, max: 20,  step: 0.1,  label: 'Planing speed (m/s)' },
    length:       { v: 9.9,  min: 3,   max: 20,  step: 0.1,  label: 'Hull length (m)' },
    beam:         { v: 2.65,  min: 1,   max: 8,   step: 0.05, label: 'Hull beam (m)' },
    // A hull making way turns about a point roughly a third of its length aft
    // of the stem, not about the stem itself. The mesh origin IS the stem, so
    // without this a turn sweeps the stern through an arc and the boat walks
    // away from its own wake. 0 restores that older behaviour.
    // Which hull is drawn. Indexes BOATS in src/boatModels.js; the last entry
    // is the original blocky placeholder, kept because it is the only one whose
    // proportions were built to match the wake's own hull maths.
    model:        { v: 4,    min: 0,   max: 5,   step: 1,    label: 'Boat model' },
    // How deep the model sits: a fraction of its own height pushed under the
    // waterline. The GLBs know nothing about where their waterline is.
    // METRES the lowest point sits below the waterline -- not a fraction of the
    // model's height, which sank a masted boat three times as deep as a dinghy
    // and put the sea inside the open ones.
    // Deep enough that a hull still has its keel wetted ON PLANE: boat.riseMax
    // lifts the whole body 0.42 m at speed, so a 0.30 m draft left the boat
    // hovering with daylight under it.
    draft:        { v: 0.85, min: 0,   max: 3,   step: 0.01, label: 'Draft (m)' },
    pivot:        { v: 0.32, min: 0,   max: 0.8, step: 0.01, label: 'Turn pivot (aft of bow)' },
    // Planing hulls bank INTO a turn. atan(v*omega/g) -- the coordinated-turn
    // relation -- so lean follows speed and rate together rather than needing
    // a curve of its own.
    bank:         { v: 1,  min: 0,   max: 2.5, step: 0.01, label: 'Bank into turns' },
    bankMax:      { v: 22,   min: 0,   max: 45,  step: 1,    label: 'Max bank (deg)' },
    // Roll is a damped spring, not a value: a hull has inertia and the water
    // damps it, so the lean LAGS the wheel. rollRate is the natural frequency
    // in Hz (a small planing hull is around 1); rollDamp is the damping ratio,
    // a little under 1 so it settles fast with a hint of overshoot as the hull
    // rolls in and catches itself.
    // Bounding-box buoyancy: the sea's real height, probed at the hull's four
    // corners (GPU readback, a frame late, smoothed), rocks the hull -- heave
    // from the average, pitch bow-to-stern, roll beam-to-beam. 0 disables.
    // How fast the keel pulls the track onto the heading in a turn. Low is a
    // skidding flat-bottom; high is a deep-vee on rails. The gap between
    // heading and course during a turn is the crab angle you can see.
    // The most the track may lag the heading. Beyond this the keel bites: it
    // is what stops a hard turn sliding the hull off its own wake.
    // How much of the foam the hull's own footprint removes. 0 lets the wake
    // run right under the boat, which is what it looks like from a chase
    // camera: the water it is cutting is the water that is foaming.
    // Purely how BIG the model is drawn. The wake still follows Hull length
    // and Beam below -- those are the numbers the field does its physics
    // with -- so a model scaled far past them will out-grow its own wake.
    modelScale:   { v: 2.4,    min: 0.2, max: 4,   step: 0.05, label: 'Model scale' },
    hullCut:      { v: 0,    min: 0,   max: 1,   step: 0.01, label: 'Cut foam under hull' },
    waterCut:     { v: 1,    min: 0,   max: 1,   step: 1,    label: 'No sea inside the hull' },
    // THE LINE WHERE THE TOPSIDES GO IN, which is the one place a moving hull
    // is most obviously in the water and the only part of it the wake cannot
    // describe -- everything the wake draws is water the boat has already
    // finished with. Here the sea is being sheared and turned over continuously
    // and is white for a hand's width all the way round. Without it a hull
    // reads as set INTO a hole in the water rather than as cutting through it,
    // however good the wake behind it is. Needs 'No sea inside the hull' on,
    // since it hugs that cut.
    waterlineFoam:  { v: 0.55, min: 0, max: 2,   step: 0.01, label: 'Foam at the waterline' },
    // How far out it reaches, as a fraction of the hull's own half-beam.
    waterlineWidth: { v: 0.22, min: 0.02, max: 1, step: 0.01, label: 'Waterline foam width' },
    crabMax:      { v: 12,   min: 0,   max: 45,  step: 1,    label: 'Max slip angle (°)' },
    grip:         { v: 0.7,  min: 0,   max: 1,   step: 0.01, label: 'Keel grip' },
    buoy:         { v: 1,  min: 0,   max: 1.5, step: 0.01, label: 'Ride the waves' },
    rollRate:     { v: 0.85, min: 0.1, max: 3,   step: 0.01, label: 'Roll rate (Hz)' },
    rollDamp:     { v: 0.72, min: 0.1, max: 2,   step: 0.01, label: 'Roll damping' },
    engines:      { v: 1,    min: 1,   max: 4,   step: 1,    label: 'Engines' },
    engineSpacing:{ v: 2.4, min: 0.2, max: 4,   step: 0.05, label: 'Engine spacing (m)' },
  },

  // The V of spray sheets. In the reference these originate at the BOW, not the
  // transom, and stay bright for a long way astern.
  arms: {
    // FOAM ON THE WAVE CRESTS, and it wants to be low.
    //
    // The wave train's steepness is an analytic function of position, so foam
    // driven straight off it is a smooth unbroken stripe running the length of
    // every crest -- the white ribbons. The height those waves carry is worth
    // having and the paint on them is not, so these two default well down and
    // the breaking is broken into patches (see Kelvin waves).
    // DEFAULTED OFF, because you have now said twice that the result looks
    // fake and you are right about why.
    //
    // These two are the entire mechanism behind the white ribbons. fromWaves
    // crossfades the wake's foam coverage between the prescribed V arms and
    // foam derived from where the Kelvin train is steep enough to break;
    // waveFoam is the gain on that second one. At 0.90 and 4.05 nearly all the
    // foam in the wake was the wave train's crests, multiplied four-fold.
    //
    // The trouble is that the steepness driving it is an analytic function of
    // position -- perfectly smooth, perfectly continuous -- so however it is
    // dressed it wants to paint an unbroken stripe down the middle of every
    // crest. Patchiness (under Kelvin waves) breaks that stripe up and is worth
    // having, but it cannot make a painted line into water.
    //
    // At 0 the wave train still displaces the surface exactly as before; it
    // simply stops being painted. Raise it if you want the effect back.
    fromWaves:    { v: 0,    min: 0,   max: 1,   step: 0.01, label: 'Foam from breaking' },
    waveFoam:     { v: 0.9, min: 0,   max: 5,   step: 0.01, label: 'Breaking foam gain' },
    // 1 = the physical angle (Kelvin 19.47 degrees while the hull is slow,
    // narrowing as atan(1/2Fr_B) once it outruns its own transverse waves).
    // 0 = whatever the slider below says, for when you want a look instead.
    autoAngle:    { v: 1,    min: 0,   max: 1,   step: 0.01, label: 'Half-angle from physics' },
    angle:        { v: 19.3, min: 4,   max: 40,  step: 0.1,  label: 'Half-angle, manual (°)' },
    width0:       { v: 1.7, min: 0.1, max: 4,   step: 0.05, label: 'Width at bow (m)' },
    widthGrow:    { v: 0.03,min: 0,   max: 0.6, step: 0.001,label: 'Width growth (m/m)' },
    foam:         { v: 0.95, min: 0,   max: 3,   step: 0.01, label: 'Foam density' },
    height:       { v: 0.42, min: 0,   max: 2,   step: 0.01, label: 'Crest height (m)' },
    innerBias:    { v: 0.38, min: 0,   max: 1,   step: 0.01, label: 'Outer-edge bias' },
    rim:          { v: 0.4, min: 0,   max: 2,   step: 0.01, label: 'Outer rim line' },
    rimWidth:     { v: 0.45, min: 0.05,max: 3,   step: 0.01, label: 'Rim thickness (m)' },
    nearBoost:    { v: 0.28, min: 0,   max: 3,   step: 0.01, label: 'Near-field boost' },
    nearLength:   { v: 34, min: 3,   max: 150, step: 1,    label: 'Near-field length (m)' },
    fadeStart:    { v: 2, min: 2,   max: 200, step: 1,    label: 'Fade start (m)' },
    fadeLength:   { v: 203, min: 5,   max: 400, step: 1,    label: 'Fade length (m)' },
    // ...and how much of the coverage that fade is NOT allowed to take with it.
    //
    // The fade above is in metres, so on its own it clears the water sooner the
    // faster the hull goes -- measured, foam gone thirteen seconds after the
    // boat at 12 m/s against a foam life of 39 s, and under four seconds at 30.
    // Real foam lasts a number of SECONDS whatever laid it. This is the floor
    // under the arc fade: the share of the arm's white that stops being a
    // thrown sheet and becomes foam lying on the water, left to die of age like
    // foam does. 0 restores the old distance-only behaviour.
    persist:      { v: 0.45, min: 0,   max: 1,   step: 0.01, label: 'Foam left on the water' },
    // WHAT THE CUSP LEAVES BEHIND IT, which is the whole reason a real wake
    // stays legible after the boat has gone.
    //
    // The arm is defined in the track's frame and OPENS with distance astern --
    // correct, the cusp line really does propagate outward -- but the foam was
    // part of that same expression and travelled with it, so the recipe only
    // ever painted where the arm IS and never where it has BEEN. Measured at a
    // fixed point 6 m off the track: 0.055 as the arm swept through, a tenth of
    // that 1.5 s later, while the age decay over the same span was 0.97.
    // Nothing was dissipating; the white had simply moved on.
    //
    // This is the deposit. The cusp crosses a patch of water at a time its own
    // outward speed decides, and what it lays there stays and dies of age.
    deposit:      { v: 0.55, min: 0,   max: 2,   step: 0.01, label: 'Foam the cusp deposits' },
    // HOW MUCH WHITE A HULL MAKES BEFORE SHE IS PLANING.
    //
    // Every foam term was multiplied by the planing ramp, so below the planing
    // speed the whole V came out at a fraction of strength -- at four metres a
    // second against a 6.5 threshold, about a quarter -- and the boat looked
    // like it was sliding through the water rather than breaking it. What
    // genuinely needs the plane is the SHEET, since a hull only throws water
    // clear once it is up and skipping. Pushing water apart still breaks it: a
    // ferry at walking pace carries a bright bow wave and a wide churned lane.
    // This is the floor under that gate, needing only that she is under way.
    displace:     { v: 0.5,  min: 0,   max: 1,   step: 0.01, label: 'Foam below planing speed' },
  },

  // The comb / scallop texture riding along each arm: periodic crests that lean
  // back from the arm axis and lengthen as the wake ages.
  feather: {
    spacing:      { v: 3.4,  min: 0.4, max: 20,  step: 0.05, label: 'Crest spacing (m)' },
    spacingGrow:  { v: 0.055,min: 0,   max: 0.4, step: 0.005,label: 'Spacing growth (m/m)' },
    lean:         { v: 1.35, min: -3,  max: 3,   step: 0.01, label: 'Crest lean' },
    depth:        { v: 0.78, min: 0,   max: 1,   step: 0.01, label: 'Comb depth' },
    jitter:       { v: 0.45, min: 0,   max: 2,   step: 0.01, label: 'Phase jitter' },
    sharpness:    { v: 1.25,  min: 0.3, max: 6,   step: 0.05, label: 'Crest sharpness' },
    carve:        { v: 0.42, min: 0,   max: 1,   step: 0.01, label: 'Comb carves foam' },
    // A feather is a row of breaking crests, not a drawn line: it comes in
    // segments with gaps, and the further astern the more of it has collapsed.
    breakup:      { v: 0.7,  min: 0,   max: 1,   step: 0.01, label: 'Crests break up' },
    breakupLen:   { v: 55,   min: 5,   max: 200, step: 1,    label: 'Whole for (m)' },
  },

  // Turbulent water dragged behind the transom: the brightest, shortest-lived
  // foam in the whole wake.
  // A bubble is not a droplet: it goes UP, it is bigger, and it lives in a
  // different medium. Its own group rather than five more sliders under a
  // heading that says prop wash.
  bub: {
    // SMALL. Cavitation bubbles are millimetres to a centimetre or so; the
    // first default drew them at 5 cm and up, which at close range is a dinner
    // plate and is most of why they read as blobs rather than as bubbles.
    size:    { v: 0.019, min: 0.003, max: 0.12, step: 0.001, label: 'Particle size (m)', ui: 'propBubbles' },
    rise:    { v: 0.53,  min: 0.05,  max: 3,   step: 0.01,  label: 'Particle rise (m/s)', ui: 'propBubbles' },
    life:    { v: 0.7,   min: 0.3,   max: 12,  step: 0.1,   label: 'Particle life (s)', ui: 'propBubbles' },
    jet:     { v: 2.35,   min: 0,     max: 8,   step: 0.05,  label: 'Thrown from the screw (m/s)', ui: 'propBubbles' },
    wobble:  { v: 0.8,  min: 0,     max: 1,   step: 0.01,  label: 'Spiral wobble', ui: 'propBubbles' },
  },

  wash: {
    // UNDERWATER BUBBLES -- particles, not field.
    //
    // These live in src/bubbles.js and are the answer to why cavitation was
    // invisible: the wake field is a top-down texture with no vertical extent,
    // so it can say the water is white and cannot say there is gas three metres
    // down rising through it. They are added to the scene, photographed by the
    // refraction pass, and composited through the surface by the water shader
    // -- so they arrive already warped by the waves and murked by depth, and
    // they can only be seen THROUGH water, which is right.
    bubRate:      { ui: 'propBubbles', v: 1440, min: 0, max: 2400, step: 10, label: 'Particles / sec' },
    // SHALLOWER by default. A bubble released a metre and a half down is seen
    // through a metre and a half of water, so it is dim where it is made and
    // only brightens as it climbs -- which puts the visible part of the plume
    // well astern of the boat that made it and reads as "released far away".
    // Nearer the surface it shows from the moment it leaves the screw.
    bubDepth:     { ui: 'propBubbles', v: 1.25, min: 0.1, max: 6, step: 0.05, label: 'Released this far down (m)' },
    // Where along the boat, relative to the measured transom. 0 is exactly on
    // it -- the orange marker in the Emitters view -- and positive is astern,
    // for a leg that stands off the counter. Negative tucks it under the hull.
    bubAft:       { ui: 'propBubbles', v: 0, min: -6, max: 8, step: 0.1, label: 'Astern of transom (m)' },
    bubSpread:    { ui: 'propBubbles', v: 0.05, min: 0.05, max: 3, step: 0.05, label: 'Released across (m)' },
    // CAVITATION -- the water boiling at the blade, not more prop wash.
    //
    // Pressure on the suction face drops below vapour pressure, the water
    // flashes to steam, and the bubbles collapse a blade-width downstream. It
    // shows as a dense white column right at the screw, a metre or two long,
    // and it is a LOAD phenomenon: a propeller cavitates when it is asked for
    // thrust it cannot get -- opening up from rest, or going hard astern -- and
    // stops once the boat is up and the blades have clean water. Which is why
    // it rides the throttle-versus-speed gap rather than speed.
    cav:          { v: 1.28,  min: 0,   max: 3,   step: 0.01, label: 'Cavitation' },
    cavLen:       { v: 1.2,  min: 0.2, max: 8,   step: 0.1,  label: 'Cavitation reach (m)' },
    cavWidth:     { v: 0.22, min: 0.05, max: 1.5, step: 0.01, label: 'Cavitation width (m)' },
    cavGrain:     { v: 5.4,  min: 0.5, max: 14,  step: 0.1,  label: 'Bubble grain' },
    cavFoam:      { v: 0.22, min: 0,   max: 1,   step: 0.01, label: 'How much reaches the surface' },
    // A screw turning over entrains air from the moment it bites, so the
    // plume exists at idle -- long before the hull is anywhere near planing.
    // Bubbles only: the white lace above stays gated on working the prop hard.
    idle:         { v: 0.96, min: 0,   max: 1.5, step: 0.01, label: 'Churn at idle' },
    width:        { v: 1.5, min: 0.2, max: 8,   step: 0.05, label: 'Width (m)' },
    widthGrow:    { v: 0.06,min: 0,   max: 0.5, step: 0.005,label: 'Width growth (m/m)' },
    foam:         { v: 0.76,  min: 0,   max: 3,   step: 0.01, label: 'Foam density' },
    length:       { v: 45, min: 2,   max: 200, step: 1,    label: 'Decay length (m)' },
    tailFoam:     { v: 0, min: 0,   max: 1,   step: 0.01, label: 'Long tail streak' },
    depth:        { v: 0.22, min: 0,   max: 1.5, step: 0.01, label: 'Trough depth (m)' },
  },

  // Water between the arms: flattened, with the transverse (following) wave
  // train arcing across it.
  // Water between the arms: flattened, and no longer carrying its own ad-hoc
  // ripple -- the Kelvin system below does that properly.
  inner: {
    flatten:      { v: 0.7,  min: 0,   max: 1,   step: 0.01, label: 'Swell flattening' , lab: 1 },
  },

  // The gravity waves. These are displacement only -- no foam -- so they carry
  // on rolling outward long after the white churn has died, and they reach the
  // full 19.47 degree wedge, which is wider than the spray arms.
  // How a wake disturbs the WATER, as opposed to how it paints it. All three of
  // these were switched off by an over-broad quiet list (see QUIET in
  // abyssalSea.js) and have never actually run.
  surface: {
    // The wake's ridge is real displaced geometry. Without a normal built from
    // it, the surface is bent and then shaded as though it were flat, which is
    // what makes a swell read as a faceted, sawtoothed decal instead of water.
    relief:  { ui: 'kelvin', v: 1,    min: 0, max: 2.5, step: 0.01, label: 'Wake ridge shading' },
    // Churned water has lost the short ripples and the wind foam riding on it.
    // This is the SHADING half: it clears the sea's own foam out of the lane.
    slick:   { ui: 'kelvin', v: 0.8,  min: 0, max: 2,   step: 0.01, label: 'Wake clears wind foam' },
    // ...and this is the GEOMETRY half: bubbles and the surfactant film they
    // carry up dissipate short gravity-capillary waves, so the chop inside a
    // track is genuinely flattened while the swell rolls straight through. It
    // is why a boat's path stays legible as a calm lane long after the white
    // has gone.
    calm:    { ui: 'kelvin', v: 0.85, min: 0, max: 1,   step: 0.01, label: 'Wake flattens the chop' },
    // WHAT COUNTS AS FULLY CHURNED WATER, and it is why the two above did
    // nothing you could see.
    //
    // Both are driven by the wake field's B channel, which is a bubble density
    // borrowed as a measure of how disturbed the water is. Measured at a fixed
    // point 5 m off the track it peaks at 0.0256 -- two and a half per cent of
    // full scale -- so multiplying it straight by a 0..1 amount asked for two
    // per cent of a slick and got exactly that. Both were on, both correct,
    // both invisible.
    //
    // Dividing by this first makes the amounts above mean what they say. Lower
    // it and less churn counts as fully slick, so the lane widens and
    // strengthens; raise it and only the boil right behind her qualifies.
    churnRef:{ ui: 'kelvin', v: 0.026, min: 0.002, max: 0.2, step: 0.001, label: 'Churn = fully slick at' },
    // HOW WIDE THE SLICK READS THE WAKE, in metres.
    //
    // The slick was driven off the surfaced-bubble channel, which in this fork
    // is the prop plume -- a ribbon a couple of metres wide down the
    // centreline. So it slicked that ribbon and left every square metre between
    // the arms exactly as choppy as the open sea, which is why the calm lane
    // never appeared however the amount was scaled.
    //
    // It now reads the foam coverage instead, which the cusp deposit spreads
    // across the whole V -- but broadly, over four taps this far apart, because
    // foam is deliberately patchy and a slick that flickers with the lace is
    // not a slick. This is the wake seen from far enough away that its
    // structure disappears, which is exactly what a slick is.
    slickReach:{ ui: 'kelvin', v: 4,  min: 0.5, max: 14, step: 0.5, label: 'Slick reads over (m)' },
    // ...and how much of that broad coverage counts as fully slick. Lower it
    // and the calm lane spreads to the thinnest edges of the wake; raise it and
    // only the heavily worked water close astern goes glassy.
    slickRef:{ ui: 'kelvin', v: 0.12, min: 0.01, max: 1, step: 0.01, label: 'Coverage = fully slick at' },
    // HOW SMOOTH THE LANE ACTUALLY GETS -- and this is the term that makes the
    // slick visible at all.
    //
    // The other three do very little in a calm scene. Clearing wind foam clears
    // foam that is not there with the sea's whitecaps off, and the slope-square
    // only widens or narrows the specular lobe. Meanwhile the chop you SEE at
    // any distance is not geometry: the fine cascades fade out with distance so
    // they cannot alias, and past a few tens of metres the whole ripple texture
    // is the shading normal. Flattening displacement while leaving the normals
    // alone smooths water that was already too far away to be displaced.
    //
    // A surfactant slick damps the capillary waves, and those ripples are what
    // scatter the sky into a matte texture. Take them out and the patch goes
    // specular and reflects the sky whole -- which is why a slick reads as a
    // smooth dark lane on a bright sea and a smooth bright one on a dark sea.
    // One mechanism, both appearances, and it is a normal rather than a height.
    slickSmooth:{ ui: 'kelvin', v: 0.8, min: 0, max: 1, step: 0.01, label: 'Slick smooths the surface' },
  },

  kelvin: {
    // THE V FROM REAL INTERFERENCE, rather than from the analytic pattern.
    //
    // Every point the hull passed is an impulse; deep-water waves disperse, so
    // at (r, tau) you see the wavenumber whose group velocity got it there, and
    // its phase is g*tau^2/(4r). Sum that along the track and the 19.47 degree
    // wedge APPEARS out of the interference -- nobody writes the angle down.
    // Stopping, turning and dispersion all come free, because they are what
    // rings do. Costs one loop over the sources per field texel, which is why
    // the count is a control and not a constant.
    interfere:    { v: 3,    min: 0,   max: 3,   step: 0.01, label: 'V from interference' },
    // How much of each impulse's ring is allowed to go AHEAD of the hull that
    // laid it. 0 is the physical answer -- water in front of a steadily moving
    // boat is undisturbed until she gets there -- and anything above it is the
    // ring sum's truncation artifact, which reads as concentric drops marching
    // out in front of the bow. Kept as a knob because seeing it is the only way
    // to be sure it is gone.
    ahead:        { v: 0,    min: 0,   max: 1,   step: 0.01, label: 'Waves ahead of the bow' },
    sources:      { v: 48,   min: 4,   max: 96,  step: 1,    label: 'Impulses summed' },
    // The shortest wave the sum is allowed to draw. Near the boat the
    // interference is dominated by half-metre to three-metre waves, and a comb
    // of those reads as drawn lines rather than as water moving. Raise it for
    // fewer, longer waves that visibly distort the surface.
    minWave:      { v: 3.6,    min: 0.6, max: 40,  step: 0.5,  label: 'Shortest wave drawn (m)' },
    amp:          { v: 0.225, min: 0,   max: 1.5, step: 0.005,label: 'Wave height (m)' },
    froudePeak:   { v: 0.52, min: 0.15,max: 1.5, step: 0.01, label: 'Peak Froude no.' },
    humpFloor:    { v: 0.55, min: 0,   max: 1,   step: 0.01, label: 'Planing floor' },
    beamGain:     { v: 0.85, min: 0,   max: 2,   step: 0.01, label: 'Beam → amplitude' },
    interference: { v: 0.55, min: 0,   max: 1,   step: 0.01, label: 'Bow/stern interference' },
    turnBias:     { v: 0.6, min: 0,   max: 2,   step: 0.01, label: 'Outside-of-turn gain' },
    waveScale:    { v: 0.26, min: 0.1, max: 3,   step: 0.01, label: 'Wavelength scale' },
    divergent:    { v: 1, min: 0,   max: 2,   step: 0.01, label: 'Divergent train' },
    transverse:   { v: 0.45, min: 0,   max: 2,   step: 0.01, label: 'Transverse train' },
    cusp:         { v: 1.4, min: 0,   max: 4,   step: 0.01, label: 'Cusp emphasis' },
    decay:        { v: 150,min: 10,  max: 800, step: 5,    label: 'Amplitude decay (m)' },
    life:         { v: 120,min: 5,   max: 300, step: 1,    label: 'Wave life (s)' },
    propagate:    { v: 1, min: 0,   max: 1,   step: 0.01, label: 'Waves run free' },
    // How patchy the breaking is along a crest. 0 paints the whole line, which
    // is the ribbon look; 1 is intermittent breaks with clear water between.
    breakPatch:   { v: 0.85, min: 0,   max: 1,   step: 0.01, label: 'Breaking is patchy' },
    breakPatchLen:{ v: 9,    min: 1,   max: 60,  step: 0.5,  label: 'Patch length (m)' },
    breakSteep:   { v: 0.075,min: 0.005,max: 0.4, step: 0.005,label: 'Breaking steepness' },
    minWave:      { v: 3.6, min: 0.5, max: 20,  step: 0.1,  label: 'Shortest wave (m)' },
  },


  // Foam appearance: how the bubble field breaks up and dies.
  foamLook: {
    scale:        { v: 1.65, min: 0.1, max: 6,   step: 0.01, label: 'Bubble scale' },
    contrast:     { v: 1.45,  min: 0.2, max: 4,   step: 0.01, label: 'Bubble contrast' },
    breakup:      { v: 0.78, min: 0,   max: 1,   step: 0.01, label: 'Break-up with age' },
    life:         { v: 72.5, min: 1,   max: 120, step: 0.5,  label: 'Foam life (s)' },
    dissolve:     { v: 3.35,  min: 0.2, max: 5,   step: 0.05, label: 'Dissolve curve' },
    // HOW FAR OLD FOAM WANDERS BEFORE IT GOES, in metres. A raft is not a decal
    // that dims: the water under it is still turning over, the bubbles drain
    // and merge, and its edges come apart. This is how far a patch is read from
    // by the end of its life -- 0 restores the old behaviour, where the pattern
    // was a fixed function of position and could only ever fade in place.
    melt:         { v: 2.6,  min: 0,   max: 8,   step: 0.05, label: 'Foam melt (m)' },
    // How big the melting eddies are: low is a few slow lobes moving whole
    // clumps together, high is every bubble going its own way, which reads as
    // boiling rather than as foam coming apart.
    meltScale:    { v: 0.12, min: 0.01, max: 0.8, step: 0.01, label: 'Melt eddy scale' },
    lace:         { v: 4.05, min: 0.5, max: 8,   step: 0.05, label: 'Lace fineness' },
    laceAmount:   { v: 0.62, min: 0,   max: 1.5, step: 0.01, label: 'Lace reach' },
    coarsen:      { v: 0.42, min: 0,   max: 1,   step: 0.01, label: 'Cells coarsen with age' },
    softness:     { v: 0.72, min: 0.02,max: 1,   step: 0.01, label: 'Edge softness' },
  },


  // Air the prop drags UNDER the surface. Not foam: these bubbles scatter light
  // back up through water, so they tint it turquoise rather than whitening it,
  // and the surface above them still reflects the sky.
  bubbles: {
    plume:        { v: 2, min: 0,   max: 4,   step: 0.01, label: 'Haze density' },
    // Churn behind a screw is a crowd of separate blobs rising and bursting,
    // not a fog. This breaks the density into clumps; it fades with age, so the
    // boil at the transom is granular and the trail behind it has diffused.
    grain:        { v: 0,  min: 0,   max: 1,   step: 0.01, label: 'Bubbles, not fog' },
    grainSize:    { v: 0.2,  min: 0.15, max: 6,  step: 0.05, label: 'Bubble clump size (m)' },
    width:        { v: 0.4, min: 0.2, max: 10,  step: 0.05, label: 'Haze width (m)' },
    spread:       { v: 0.064,min: 0,   max: 0.5, step: 0.001,label: 'Spread (m/m)' },
    length:       { v: 76,min: 5,   max: 400, step: 1,    label: 'Decay length (m)' },
    fromArms:     { v: 0.16, min: 0,   max: 2,   step: 0.01, label: 'Entrained by arms' },
    armsLength:   { v: 192, min: 5,   max: 400, step: 1,    label: 'Entrained decay (m)' },
    life:         { v: 33, min: 2,   max: 200, step: 1,    label: 'Haze life (s)' },
    depth:        { v: 1.7, min: 0.1, max: 6,   step: 0.05, label: 'Haze depth (m)' },
    rise:         { v: 0.26, min: 0.02,max: 2,   step: 0.01, label: 'Haze rise (m/s)' },
    extinction:   { v: 1.13, min: 0,   max: 2,   step: 0.01, label: 'Water extinction /m' },
    deepTint:     { v: 0.51, min: 0,   max: 1,   step: 0.01, label: 'Deep-water tint' },
    mottle:       { v: 0.47, min: 0,   max: 1,   step: 0.01, label: 'Cloudiness' },
    brightness:   { v: 0.78, min: 0,   max: 3,   step: 0.01, label: 'Backscatter' },
    tint:         { v: 0.48, min: 0,   max: 1,   step: 0.01, label: 'Green / blue' },
    milkiness:    { v: 0.25, min: 0,   max: 1,   step: 0.01, label: 'Milkiness' },
  },

  // The lace is alive: it surges with the waves, shears in the churn, and its
  // cells burst and re-form. All of it is LOCAL motion — nothing here may drift,
  // or the foam would slide across water it is supposed to be floating on.
  foamMotion: {
    rideWaves:    { v: 0.8, min: 0,   max: 3,   step: 0.01, label: 'Foam rides the waves' , lab: 1 },
    drift:        { v: 0.55, min: 0,   max: 3,   step: 0.01, label: 'Rides the swell' , lab: 1 },
    ringAmount:   { v: 0.75, min: 0,   max: 3,   step: 0.01, label: 'Ring push (m)' , lab: 1 },
    ringScale:    { v: 3.4, min: 0.8, max: 30,  step: 0.1,  label: 'Ring spacing (m)' , lab: 1 },
    ringSpeed:    { v: 0.4, min: 0.02,max: 2,   step: 0.01, label: 'Ring speed' , lab: 1 },
    ringWidth:    { v: 0.7, min: 0.1, max: 5,   step: 0.05, label: 'Wavefront width (m)' , lab: 1 },
    cellGrowth:   { v: 0, min: 0,   max: 0.8, step: 0.005,label: 'Cells expand' , lab: 1 },
    ringRelief:   { v: 0, min: 0,   max: 3,   step: 0.01, label: 'Rings show in water' , lab: 1 },
    boil:         { v: 0.45, min: 0,   max: 2,   step: 0.01, label: 'Cells burst / re-form' , lab: 1 },
    plumeSwirl:   { v: 0.45, min: 0,   max: 2,   step: 0.01, label: 'Plume swirl' , lab: 1 },
  },

  // How the foam sits on the water rather than on top of it.
  foamMix: {
    // Abyssal's foam grading expects a coverage field that saturates near 1;
    // the prototype's peaks around 0.12, so the wake needs gain before it is
    // shaded or it is drawn at a few percent opacity and reads as clean water.
    wakeGain:     { v: 1.9,  min: 0,   max: 16,  step: 0.1,  label: 'Wake foam gain' },
    // The SEA's own whitecaps, not the wake's. 1 gives them the same lace the
    // boat leaves behind -- Abyssal's own is a Worley web, and it thresholds in
    // exactly the same form, so this swaps the field and nothing else.
    seaLace:      { v: 0,    min: 0,   max: 1,   step: 0.01, label: 'Sea foam uses our lace' },
    // ...and coverage from waves actually BREAKING: steepness is amplitude
    // times wavenumber, which for a surface is the magnitude of its slope, and
    // past a critical value a crest spills. Additive, because the FFT's own
    // Jacobian fold catches where the surface folds OVER, which slope alone
    // cannot -- so this adds the steep-crest case rather than replacing it.
    // Surf breaking on the shore: driven by how deep the water is over the
    // real coastline, not by the open sea's whitecaps.
    surf:         { v: 0.95, min: 0,   max: 2,   step: 0.01, label: 'Surf on the shore' },
    surfDepth:    { v: 1.4,  min: 0.3, max: 8,   step: 0.1,  label: 'Breaks at depth (m)' },
    surfSets:     { v: 1,    min: 0,   max: 2,   step: 0.01, label: 'Surf sets (surge)' },
    surfPeriod:   { v: 7,  min: 2,   max: 16,  step: 0.1,  label: 'Seconds between sets' },
    surfSpan:     { v: 0.55, min: 0.1, max: 10,  step: 0.05, label: 'Set spacing (m of depth)' },
    surfDecay:    { v: 3,  min: 0.2, max: 9,   step: 0.05, label: 'Foam dies off (per set)' },
    softness:     { v: 0.55, min: 0,   max: 1,   step: 0.01, label: 'Foam softness (less white)' },
    seaWhitecaps: { v: 0,    min: 0,   max: 2,   step: 0.01, label: 'Sea whitecaps (not the wake)' },
    seaBreak:     { v: 0, min: 0,   max: 1.5, step: 0.01, label: 'Sea foam from breaking' },
    density:      { v: 1.05, min: 0.3, max: 8,   step: 0.05, label: 'Opacity build' },
    translucency: { v: 0.58, min: 0,   max: 1,   step: 0.01, label: 'Water shows through' , lab: 1 },
    aeration:     { v: 0.44, min: 0,   max: 1.5, step: 0.01, label: 'Aerated teal halo' , lab: 1 },
    relief:       { ui: 'kelvin', v: 0.94, min: 0,   max: 3,   step: 0.01, label: 'Bubble relief' , lab: 1 },
    troughBias:   { v: 0.4, min: 0,   max: 1.5, step: 0.01, label: 'Pools in troughs' , lab: 1 },
    warmth:       { v: 0.18, min: 0,   max: 1,   step: 0.01, label: 'Sunlit warmth' , lab: 1 },
  },

  // WATER & LIGHT -- all of it drives the Abyssal sea now.
  //
  // This group used to drive the lab's own analytic ocean, which is hidden
  // whenever Abyssal is on: every slider in it moved something nobody could
  // see. The ones with a real counterpart were repointed (and re-ranged, since
  // Abyssal's units are its own); the ones without were retired.
  ocean: {
    // Sea state. These three are baked into the FFT's initial spectrum, so
    // moving them rebuilds it -- once, on change, not per frame.
    waveHeight:   { ui: 'seaState', v: 0.43,    min: 0,   max: 3,   step: 0.01, label: 'Wave height ×' },
    swellAmp:     { ui: 'seaState', v: 0.14, min: 0,   max: 1,   step: 0.01, label: 'Swell amount' },
    swellLen:     { ui: 'seaState', v: 5.5,  min: 3,   max: 18,  step: 0.1,  label: 'Swell period (s)' },
    chopAmp:      { ui: 'seaState', v: 0.78, min: 0,   max: 1.5, step: 0.01, label: 'Choppiness' },
    // Light.
    sunElev:      { ui: 'sunSky', v: 4.2,   min: 0,   max: 88,  step: 1,    label: 'Sun elevation (°)' },
    sunAzim:      { ui: 'sunSky', v: 48,  min: 0,   max: 360, step: 1,    label: 'Sun azimuth (°)' },
    reflectivity: { ui: 'sunSky', v: 2.63, min: 0,   max: 3,   step: 0.01, label: 'Sky ambient' },
    sunGlow:      { ui: 'sunSky', v: 7,    min: 0.2, max: 8,   step: 0.05, label: 'Sun disc size ×' },
    hazeStart:    { ui: 'sunSky', v: 1,    min: 0,   max: 3,   step: 0.01, label: 'Aerial haze' },
    // GLITTER ONLY BREAKS THE SUN PATH UP -- it cannot make one.
    //
    // Worth knowing before reaching for it: the scintillation it drives has an
    // analytically unit mean, so it redistributes the specular lobe's radiance
    // and never creates any. Raising it gives brighter flashes with darker
    // water between them, not a brighter or wider path. It is also gated on
    // sub-pixel slope variance, so on glassy water it does nothing at all.
    // For a bigger, brighter path, reach for Specular below.
    sheen:        { ui: 'waterLook', v: 1,    min: 0,   max: 4,   step: 0.01, label: 'Glitter strength' },
    // AND THIS IS THE ONE THAT MAKES IT VISIBLE AT ALL.
    //
    // Each scintillation octave dies once a pixel covers more sea than the
    // flashes are wide -- the right call, since sub-pixel flashes are just
    // aliasing. But the flashes were about 0.6 m and 0.16 m across, and a
    // grazing pixel anywhere down a sun path covers metres. So the whole path,
    // which is the only place glitter belongs, was past the cutoff and the
    // strength slider drove a term that had already returned 1.0.
    //
    // This is the flash size in metres. Bigger flashes survive a coarser pixel
    // and reach further down the path.
    glitterSize:  { ui: 'waterLook', v: 3.2,  min: 0.3, max: 12,  step: 0.1,  label: 'Glitter grain (m)' },
    // WAVE SETS. An FFT sea is Gaussian and so is statistically identical
    // everywhere at once; real water arrives in groups, because components of
    // slightly different wavelength beat against each other as they travel.
    // That beating is why a sea has moods and why one wave in a set stands
    // clear of its neighbours. 0 is the plain Gaussian sea.
    groups:       { ui: 'seaState', v: 0.45, min: 0,   max: 1.2, step: 0.01, label: 'Wave sets / outliers' },
    groupLen:     { ui: 'seaState', v: 260,  min: 40,  max: 900, step: 10,   label: 'Set length (m)' },
    // HOW BIG A STRAY WAVE MAY GET, as multiples of the base wave height.
    //
    // The sets field is bell-shaped -- a sum of two noise octaves -- so most
    // water sits near the middle and the extremes are genuinely rare, which is
    // the right shape for a sea. These two say where those extremes are: the
    // lull between sets and the one wave that stands well clear of its
    // neighbours. 'Wave sets / outliers' above is the master; at 0 the sea is
    // uniform again whatever these say.
    groupLo:      { ui: 'seaState', v: 0.55, min: 0.05, max: 1,  step: 0.01, label: 'Smallest wave ×' },
    // Raised to 100 as asked -- but be warned what it does. It scales the WHOLE
    // field in a patch, so a large value is not one big wave, it is every wave
    // in that patch made enormous, and past about 6 the horizontal displacement
    // folds through itself and the surface self-intersects. For a single big
    // wave rolling in, use the rogue set below: that is a different mechanism
    // and the one that does what it sounds like.
    groupHi:      { ui: 'seaState', v: 1.9,  min: 1,    max: 100, step: 0.05, label: 'Biggest wave ×' },

    // THE ROGUE SET -- one long-crested wave that rolls through and passes on.
    //
    // Not the sea scaled up: a PACKET, a few crests long, travelling in one
    // direction with ordinary water either side of it. That is what arrives out
    // of a calm sea, and it is why scaling the field could never produce it.
    // Height is in METRES, straight -- set it to 12 and a twelve-metre wave
    // comes through. Its speed is the deep-water relation sqrt(g*lambda/2pi),
    // so a long swell outruns a short one exactly as it should.
    rogueH:       { ui: 'seaState', v: 0,   min: 0,  max: 40,  step: 0.1, label: 'Rogue wave height (m)' },
    rogueLen:     { ui: 'seaState', v: 110, min: 15, max: 500, step: 5,   label: 'Rogue wavelength (m)' },
    rogueEvery:   { ui: 'seaState', v: 45,  min: 8,  max: 240, step: 1,   label: 'One every (s)' },
    rogueSteep:   { ui: 'seaState', v: 0.6, min: 0,  max: 1.4, step: 0.01, label: 'Rogue steepness' },
    // The halo around the sun, from aerosol forward scattering. Built out of
    // the atmosphere's own transmittance, so it reddens with the disc at sunset
    // instead of staying a white sprite.
    sunAura:      { ui: 'sunSky', v: 1,  min: 0,   max: 4,   step: 0.01, label: 'Sun aura' },
    sunAuraFall:  { ui: 'sunSky', v: 2.4,  min: 0.8, max: 5,   step: 0.05, label: 'Aura falloff' },
    specular:     { ui: 'waterLook', v: 0.55, min: 0,   max: 2,   step: 0.01, label: 'Specular' },
    exposure:     { ui: 'waterLook', v: 1.2,  min: 0.2, max: 3,   step: 0.01, label: 'Exposure' },
    // Retired with the analytic ocean: 'Water lightness' and 'Blue / teal'
    // duplicated Sky & weather's clarity / tint / glow, and 'Wave sheen' is
    // now Glitter above.
    deepColor:    { ui: 'waterLook', v: 0.021,min: 0,   max: 0.4, step: 0.001,label: 'Water lightness', lab: 1 },
    tint:         { ui: 'waterLook', v: 0.42, min: 0,   max: 1,   step: 0.01, label: 'Blue / teal', lab: 1 },
  },

  // A volcanic lagoon shore at real scale: jagged rock at the waterline,
  // sandy shelves dipping under it, a pine-topped headland behind.
  shore: {
    on:           { v: 1,    min: 0,   max: 1,   step: 1,    label: 'Lagoon shore' },
    bay:          { v: 300,  min: 90,  max: 900, step: 10,   label: 'Bay radius (m)' },
    rugged:       { v: 1,    min: 0,   max: 2,   step: 0.01, label: 'Coast ruggedness' },
    boulders:     { v: 1400, min: 0,   max: 4000,step: 50,   label: 'Boulders' },
    // Water bursting off the rocks the surf breaks on. Driven by the SAME
    // travelling-set phase the shore foam is, so a rock throws its spray as the
    // visible foam line reaches it rather than on a timer of its own.
    spray:        { v: 1,    min: 0,   max: 3,   step: 0.01, label: 'Spray off the rocks' },
    sprayRate:    { v: 14,   min: 1,   max: 60,  step: 1,    label: 'Droplets per burst' },
    spraySpeed:   { v: 5.2,  min: 0.5, max: 16,  step: 0.1,  label: 'Burst speed (m/s)' },
    sprayRise:    { v: 1.15, min: 0,   max: 2.5, step: 0.01, label: 'Upward share' },
    sprayLife:    { v: 1.5,  min: 0.2, max: 4,   step: 0.05, label: 'Droplet life (s)' },
    // Droplet size for rock spray, as a fraction of the boat's. Water
    // shattering on stone atomises far finer than a sheet peeling off a chine.
    sprayDrop:    { v: 0.42, min: 0.1, max: 1.5, step: 0.01, label: 'Rock droplet size x' },
    sprayRange:   { v: 240,  min: 40,  max: 600, step: 10,   label: 'Only within (m)' },
  },

  // Cost, not looks. Auto-set on load from the device, then yours to override.
  // Sky, weather and shore.
  // Water that has left the water. Everything else the prototype draws is a
  // field on the surface; this is the one part that is airborne, so it is
  // particles and it lands.
  spray: {
    amount:    { v: 1,    min: 0,   max: 2,   step: 0.01, label: 'Spray amount' },
    rate:      { v: 26,   min: 0,   max: 160, step: 1,    label: 'Droplets /s per m/s' },
    sites:     { v: 4,    min: 1,   max: 8,   step: 1,    label: 'Emission sites' },
    minSpeed:  { v: 2.2,  min: 0,   max: 12,  step: 0.1,  label: 'Throws above (m/s)' },
    throw:     { v: 0.34, min: 0,   max: 1.2, step: 0.01, label: 'Throw x speed' },
    rise:      { v: 0.55, min: 0,   max: 2,   step: 0.01, label: 'Upward share' },
    spread:    { v: 0.45, min: 0,   max: 2,   step: 0.01, label: 'Scatter' },
    drag:      { v: 1.35, min: 0,   max: 6,   step: 0.05, label: 'Air drag' },
    life:      { v: 1.1,  min: 0.1, max: 4,   step: 0.05, label: 'Droplet life (s)' },
    size:      { v: 0.1, min: 0.01,max: 0.6, step: 0.01, label: 'Droplet size (m)' },
    opacity:   { v: 0.85, min: 0,   max: 1,   step: 0.01, label: 'Droplet opacity' },
    // How heavy-tailed the droplet spectrum is. 0 is the old uniform spread --
    // every droplet much the same size, moving as one sheet. Turn it up and
    // most droplets come out small: because drag goes as 1/r those fine ones
    // stop dead and hang as a haze while the few big ones fly on, which is the
    // separation real spray has and a single-size population cannot.
    fine:      { v: 0.7,  min: 0,   max: 1,   step: 0.01, label: 'Fine mist share' },
    // Shutter, in seconds. A droplet is smeared along its own velocity by how
    // far it travels in this long -- 0 gives round dots, which is the shape
    // that makes spray read as snow. Roughly a film camera's 1/50 by default.
    streak:    { v: 0.02, min: 0,   max: 0.08, step: 0.002, label: 'Motion streak (s)' },
    // Forward-scatter gain: how much brighter a droplet is when the sun is
    // behind it. This is what makes a curtain of spray blaze into the light
    // and go flat grey away from it.
    glow:      { v: 2.2,  min: 0,   max: 8,   step: 0.1,  label: 'Backlit glow' },
    // WHAT A TURN THROWS.
    //
    // A hull only turns by throwing water sideways -- to pull herself round she
    // pushes the sea out, and the reaction is the turn -- so the spray a turn
    // makes is not decoration on the manoeuvre, it is the manoeuvre. This
    // scales it by |v.omega| / g, the coordinated-turn ratio bank() already
    // runs on: zero running straight, about 0.4 at the 22 degree bank cap, and
    // rising with BOTH speed and helm, which is why a hard turn at walking pace
    // throws nothing and the same helm at speed throws a wall. It biases the
    // emission to the OUTSIDE chine, which is the one buried and working, and
    // throws that side faster and higher.
    carve:     { v: 2.4,  min: 0,   max: 8,   step: 0.05, label: 'Spray from carving' },
  },

  scene: {
    // 1 draws the vendored Abyssal FFT sea and volumetric sky; 0 the lab's own
    // analytic ocean. Both carry the same wake -- that is the point of keeping
    // the switch rather than deleting the loser.
    abyssal:      { ui: 'render', v: 1,    min: 0,   max: 1,   step: 1,    label: 'Abyssal sea' },
    // Strips the sea's shading and paints the wake's HEIGHT instead: crests
    // warm, troughs cold, still water black, with the zero contour picked out
    // so the crest lines are legible. Everything that makes water look like
    // water is also what hides a few centimetres of height moving across it.
    // Markers at every emitter, drawn through the hull and the water. Toggled
    // by the Emitters button beside the view controls.
    debugEmit:    { ui: 'render', v: 0, min: 0, max: 1, step: 1, label: 'Debug: emitter markers' },
    waveDebug:    { ui: 'render', v: 0,    min: 0,   max: 1,   step: 1,    label: 'Debug: wave motion' },
    waveDebugScale:{ ui: 'render', v: 0.15, min: 0.01, max: 1.5, step: 0.01, label: 'Debug: height scale (m)' },
    // Index into PRESET_NAMES in abyssalSea.js, calmest first: turning it up
    // means more sea. Drives the wave spectrum AND the light, because in
    // Abyssal they are one parameter set, not two.
    preset:       { ui: 'seaState', v: 6,    min: 0,   max: 9,   step: 1,    label: 'Weather preset' },
    // The prototype already has a lake bottom (the terrain). Abyssal's presets
    // carry their own procedural seafloor, and a shallow one under green lake
    // water reads as a bright green pool. 0 pushes it out of sight, 1 restores
    // exactly what the preset asked for.

    waterTint:    { ui: 'waterLook', v: 0.8,  min: 0,   max: 1,   step: 0.01, label: 'Deep-water tint' },
    // Straight down, Fresnel reflects ~2% of the sky, so a look-down view sees
    // only what the water column scatters back. This scales that, and it is
    // the reason an overhead camera can look black on a preset authored for a
    // dark lake. 1 is exactly what the preset asked for.
    // Exposure for the MESHES only -- boat, terrain, spray. The sea does its own
    // tonemapping inside its own shader, so this cannot touch it. Without it a
    // textured hull clips to white and looks untextured.
    // 0.85 was too dark once ACES was added on top of halved lights: these
    // models carry baked ambient occlusion and fairly dark albedo, so they
    // read as untextured grey long before they read as underlit.
    meshExposure: { ui: 'render', v: 1,  min: 0.1, max: 4,   step: 0.01, label: 'Mesh exposure' },
    // Master on the sun and sky reaching the MESHES. Their ratio comes from
    // the sun's elevation, so this scales both together rather than letting
    // them drift apart.
    meshSun:      { ui: 'render', v: 1,  min: 0,   max: 3,   step: 0.01, label: 'Mesh sun & sky' },
    // Screen-space refraction: the submerged half of the hull, seen THROUGH
    // the surface, wobbled by the surface normal and murked by depth. 0 turns
    // the extra scene pass off entirely.
    refraction:   { ui: 'waterLook', v: 0.9,  min: 0,   max: 2.5, step: 0.01, label: 'See-through water' },
    // Resolution of that extra pass, as a fraction of the canvas. It is the
    // single most expensive thing in the frame -- measured at ~18% of it --
    // because it draws the whole scene a second time at full size. What comes
    // back is then warped by the surface normal and murked by depth, so most
    // of that resolution is destroyed before it is ever seen.
    //
    // Not free below ~0.5, and the reason is the hull cut rather than the
    // refracted image: the cut asks this pass's DEPTH, per pixel, where the
    // boat actually is, so a coarser buffer coarsens the waterline edge.
    refrScale:    { ui: 'waterLook', v: 0.6,  min: 0.25, max: 1, step: 0.05, label: 'Refraction pass scale' },
    // The boat's image in the water, and the shadow it throws on it.
    //
    // A ray-sphere proxy at the craft rather than a reflection pass: R is
    // already the direction a fragment looks in the mirror, so if R points at
    // the boat, the boat is what it reflects. It costs one branch instead of a
    // second render of the scene, and because R comes from the wavy normal the
    // image wobbles with the real waves rather than with a planar pass's fake.
    // It is a soft blob at the boat's scale -- it will not give you rigging.
    // THE REAL REFLECTION: the scene drawn a second time from a camera mirrored
    // through the water plane, so what appears in the water is the actual mesh
    // -- masts, superstructure, the dark hull against white topsides -- rather
    // than the proxy's boat-shaped smear.
    //
    // It costs a full extra draw of the scene, which is what the refraction pass
    // measured at (~18% of the frame at chase range). Half resolution by
    // default: a mirror image seen through a moving surface is the least
    // resolution-critical thing in the frame.
    //
    // Its lie is the flat mirror -- rendered for y = seaLevel, not for the wave
    // under each fragment -- so the wobble is put back by hand from the surface
    // normal. The proxy gets that free and has no geometry; the two are worth
    // having together.
    planarRefl:   { ui: 'mirror', v: 1.5,   min: 0,   max: 1.5, step: 0.01, label: 'Mirror reflection (real mesh)' },
    planarScale:  { ui: 'mirror', v: 0.65, min: 0.2, max: 1,   step: 0.05, label: 'Mirror pass scale' },
    planarDistort:{ ui: 'mirror', v: 1,   min: 0,   max: 4,   step: 0.01, label: 'Mirror wobble' },
    // Softness, as a fraction of the reflection's mip chain. Sampling a coarser
    // level is ONE fetch, where a blur kernel wide enough to read as wet glass
    // would be dozens of taps per pixel across the whole sea. Surface roughness
    // already climbs the chain on its own; this is a floor under that.
    planarBlur:   { ui: 'mirror', v: 0.16, min: 0, max: 1,   step: 0.01, label: 'Mirror blur' },
    // HOW FAST IT DIES BACK, measured along the reflection's own length from
    // the boat outward -- not from the camera, which is a different quantity
    // and dims the far sea whether or not there is a reflection in it.
    //
    // A RATE, per metre, applied exponentially: 0 gives exp(0) = 1 and nothing
    // fades, and raising it pulls the image back toward the hull. Expressing it
    // this way means zero needs no special case, which a length-based fade
    // always ends up getting wrong somewhere. 0.04 halves the reflection every
    // 17 m or so.
    planarFade:   { ui: 'mirror', v: 0.02, min: 0, max: 0.4, step: 0.002, label: 'Mirror fade rate (per m)' },
    // HOW MUCH OF THE WATER IT MAY CLAIM. Separate from strength on purpose:
    // strength is how bright the reflected image is, this is the ceiling on how
    // much of the surface it is allowed to become. At 1 the mirror can replace
    // the sky outright, which is right for glass and wrong for almost anything
    // else -- real water keeps some of its own colour even at grazing angles.
    planarOpacity:{ ui: 'mirror', v: 0.7, min: 0, max: 1, step: 0.01, label: 'Mirror opacity' },
    boatReflect:  { ui: 'mirror', v: 0, min: 0,  max: 2.5, step: 0.01, label: 'Boat reflection (proxy blob)' },
    boatShadow:   { ui: 'mirror', v: 0,  min: 0,   max: 1.5, step: 0.01, label: 'Boat shadow on water' },
    // How far down you can see. Divides the water's absorption, so 2 means
    // roughly twice the sight depth -- the bed, a submerged keel and the
    // bubble plume all reach the same distance, because they are all looking
    // through the same water.
    // The hull's shadow on the sea bed. Only visible where there IS a bed --
    // raise 'Bed depth' under The Lake to bring one into view.
    hullShadow:   { ui: 'bed', v: 1,    min: 0,   max: 1,   step: 0.01, label: 'Boat shadow on the bed' },
    clarity:      { ui: 'waterLook', v: 1,    min: 0.2, max: 3,   step: 0.05, label: 'Water clarity (see-through depth)' },
    waterGlow:    { ui: 'waterLook', v: 3.6,  min: 0.2, max: 10,  step: 0.05, label: 'Water glow (look-down)' },
    warmth:       { ui: 'sunSky', v: 1.15, min: 0,   max: 1.5, step: 0.01, label: 'Sunset warmth' },
    cloud:        { ui: 'sunSky', v: 0.55, min: 0,   max: 1,   step: 0.01, label: 'Cloud cover' },
    cloudScale:   { ui: 'sunSky', v: 0.55, min: 0.05,max: 3,   step: 0.01, label: 'Cloud scale' },
    cloudSoft:    { ui: 'sunSky', v: 0.3, min: 0.02,max: 1,   step: 0.01, label: 'Cloud softness' },
    treeline:     { ui: 'oldLake', v: 0.008, min: 0,   max: 0.08,step: 0.001,label: 'Shore height' , lab: 1 },
    treeRough:    { ui: 'oldLake', v: 0.45, min: 0,   max: 1.5, step: 0.01, label: 'Shore roughness' , lab: 1 },
    treeDark:     { ui: 'oldLake', v: 0.02, min: 0,   max: 0.6, step: 0.005,label: 'Shore lightness' , lab: 1 },
  },

  // The lake itself -- real geometry, not a painted horizon.
  lake: {
    // A shallow SAND bed, which is what a lake actually has. It also lights
    // the water from below: with no visible bottom, an overhead camera at a
    // 38 degree sun sees only what the column scatters back, which is why
    // pushing the floor away turned the look-down view black. 0 = no floor.
    // The pond the boats keep to. Read at startup (the park is built once);
    // the confinement uses it live.
    pond:         { ui: 'oldLake', v: 0,  min: 60,  max: 900, step: 10,   label: 'Pond radius (m)' },
    // Nominal bed depth, and the whole procedural bottom hangs off it: the
    // shallowest banks come to 0.45x this and the basins fall to 2.3x. It used
    // to default to 0 -- which pushes the floor to 400 m, out of sight -- back
    // when a baked coast map painted the only bottom anyone saw. With that map
    // gone this is the sea bed, everywhere, so it has to be a real number.
    floorDepth:   { ui: 'bed', v: 0,  min: 0,   max: 60,  step: 0.5,  label: 'Bed depth (m)' },
    weed:         { ui: 'bed', v: 0.3, min: 0,   max: 1,   step: 0.01, label: 'Weed over sand' },
    // How bright the bed comes back. The scene's exposure is set for the
    // water surface, and an unscaled bottom clips to white -- which costs
    // the caustics, since a clipped surface cannot carry contrast.
    coral:        { ui: 'bed', v: 0.85, min: 0,   max: 1.5, step: 0.01, label: 'Coral heads' },
    bedBright:    { ui: 'bed', v: 0.3, min: 0.02, max: 2, step: 0.01, label: 'Bed brightness' },
    // The surface's own slope, bending the view of the bottom: this is what
    // makes the sand shift under a passing wave.
    bedDistort:   { ui: 'bed', v: 1,  min: 0,   max: 3,   step: 0.01, label: 'Distortion through surface' },
    causticSize:  { ui: 'bed', v: 3,  min: 0.3, max: 10, step: 0.1,  label: 'Caustic cell size' },
    caustics:     { ui: 'bed', v: 0.85, min: 0,   max: 1.5, step: 0.01, label: 'Caustics on the bed' },
    radius:       { ui: 'oldLake', v: 1850, min: 200, max: 4000,step: 10,   label: 'Lake radius (m)' , lab: 1 },
    depth:        { ui: 'oldLake', v: 14,   min: 2,   max: 60,  step: 1,    label: 'Basin depth (m)' , lab: 1 },
    rim:          { ui: 'oldLake', v: 70,   min: 10,  max: 400, step: 5,    label: 'Hill height (m)' , lab: 1 },
    relief:       { ui: 'oldLake', v: 34,   min: 0,   max: 120, step: 1,    label: 'Relief (m)' , lab: 1 },
    wobble:       { ui: 'oldLake', v: 0.3, min: 0,   max: 0.8, step: 0.01, label: 'Shoreline wobble' , lab: 1 },
    islands:      { ui: 'oldLake', v: 55,   min: 0,   max: 200, step: 1,    label: 'Islands' , lab: 1 },
    avoid:        { ui: 'oldLake', v: 0, min: 0,   max: 3,   step: 0.01, label: 'Shore avoidance' },
    canopy:       { ui: 'oldLake', v: 0.1, min: 0.01,max: 0.6, step: 0.005,label: 'Canopy lightness' , lab: 1 },
  },

  quality: {
    renderScale:  { v: 2,  min: 0.5, max: 2,   step: 0.25, label: 'Render scale' },
    oceanDetail:  { v: 560,  min: 140, max: 760, step: 20,   label: 'Ocean detail' },
  },

  field: {
    // How much the speed AT THE MOMENT OF EMISSION shapes the foam left behind.
    //
    // Density goes as v^2 -- a planing hull's drag goes as v^2, so the power
    // into the water goes as v^3, spread along a track laid at v m/s, which is
    // v^2 of energy per metre. Persistence goes as sqrt(v), deliberately much
    // weaker: a thicker raft lasts longer because there is more of it, not
    // because its bubbles rise slower. Scaling both by v^2 would give a fast
    // boat a trail with no end.
    //
    // 0 restores one flat setting for every speed.
    speedDrive:   { v: 1,    min: 0,   max: 1,   step: 0.01, label: 'Speed shapes the wake' },
    speedRef:     { v: 13,   min: 2,   max: 40,  step: 0.5,  label: 'Reference speed (m/s)' },
    // One knob over every lifetime and decay length in the wake. The individual
    // ones stay where they are; this scales all of them at once, because
    // "make it die faster" should not mean hunting through four groups.
    decay:        { v: 1.85, min: 0.2, max: 8,   step: 0.05, label: 'Wake decay ×' },
    adaptive:     { v: 0.85, min: 0,   max: 1,   step: 0.01, label: 'Shrink field on zoom-in' },
    extent:       { v: 270,  min: 80,  max: 700, step: 10,   label: 'Wake field size (m)' },
    trailLength:  { v: 280,  min: 50,  max: 1200,step: 10,   label: 'Trail length (m)' },
    // HOW MUCH OF THE RIBBON THE HULL OWNS RATHER THAN THE TRACK.
    //
    // The ribbon follows the path the anchor travelled, and the hull is taken
    // to occupy its first hull-length. Running straight those are one line. In
    // a turn they are not: a hull pivots about a point a third of its length
    // aft of the stem, so the transom swings OUTSIDE the track the bow drew --
    // by more than a beam when she is hard over. Placing the wash a
    // hull-length back along the TRACK therefore puts it where the bow was
    // rather than where the stern is, which is the wake that hangs behind while
    // the stern skids out from under it.
    //
    // Water she is touching right now lies along the hull, not along its
    // history, so this pulls that length of ribbon onto the hull's own axis and
    // lets it fade back to the recorded path half a length aft of the transom.
    // 0 restores the track-only behaviour.
    rigid:        { v: 1,    min: 0,   max: 1,   step: 0.01, label: 'Wake follows the hull' },
  },
};

export const flat = () => {
  const out = {};
  for (const [g, entries] of Object.entries(PARAMS))
    for (const [k, p] of Object.entries(entries)) out[`${g}.${k}`] = p.v;
  return out;
};

export const get = (path) => {
  const [g, k] = path.split('.');
  const entry = PARAMS[g]?.[k];
  // A missing parameter otherwise surfaces as "cannot read 'v' of undefined"
  // somewhere in a shader uniform sync, a long way from the actual cause.
  if (!entry) throw new Error(`unknown parameter: ${path}`);
  return entry.v;
};

export const set = (path, value) => {
  const [g, k] = path.split('.');
  if (PARAMS[g] && PARAMS[g][k]) PARAMS[g][k].v = +value;
};
