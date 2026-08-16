const KEY = 'mcqueen-speedway';

const DEFAULTS = {
  car: 'lightning_mcqueen',
  track: 'msots',
  laps: 5,
  quality: 'high',
  // **The only difficulty there is.** The picker is gone: the owner races Hard
  // and nothing else, so there is one setting and it is not on screen. The
  // other two entries in DIFFICULTY below are still live - the multiplayer
  // HELP control maps onto their `assist`/`lift`, which is how a child gets a
  // hand on the same grid - so do not delete them.
  difficulty: 'hard',
  physics: 'sport',
  // How much the car drives itself in a race against other people. The host
  // sets one level for the grid; it defaults to none, and `easy` here is what
  // makes a car drive itself for a five-year-old.
  help: 'hard',
  sound: true,
  volume: 0.8,
};

/**
 * AI behaviour per difficulty.
 *
 * `assist` is a grip multiplier for the player only. It does nothing under
 * Arcade, which has no grip model, and exists so that Easy stays winnable by
 * holding the throttle down - a small child can tap any entry in the menu.
 * `lift` is the matching corner-braking aid: grip alone cannot save a driver
 * who never lifts, so on Easy the car slows itself for the turns.
 *
 * **Pace comes in two flavours, and that is the point.** `aiSpeed`/`aiCorner`
 * are how a rival drives when it is *not* being raced - the pace you catch
 * them at. `chaseSpeed`/`chaseCorner` are how it drives with a grudge, in the
 * ten seconds after a human passes it. Hard cruises at Normal's pace and only
 * shows its real speed once you are ahead of it: you can always reel them in
 * and get by, and then you have to hold them off. A rival that is simply
 * faster than you everywhere is not hard, it is just gone.
 *
 * `fight` is how much grudge one pass is worth, and `defend` how far they will
 * move to cover the inside line *before* you commit - they always concede once
 * you are alongside. Easy defends not at all, on purpose: a five-year-old
 * holding the throttle down has to be able to get past, and that outranks the
 * racing.
 */
export const DIFFICULTY = {
  easy: {
    label: 'Easy', aggression: 0.55, band: 0.7, playerSpeed: 1.0,
    assist: 1.9, lift: 1.0, fight: 0.15, defend: 0,
    aiSpeed: 0.88, aiCorner: 0.84,          // cruising
    chaseSpeed: 0.90, chaseCorner: 0.86,    // ... and with a grudge
  },
  /**
   * Normal is Hard, and then it lets you win.
   *
   * Every number below is Hard's - they race you exactly as hard, all race -
   * with one difference: on the final lap any rival still ahead of a human
   * lifts by `concede`, so the race comes back to you at the end however it
   * has gone. That is the owner's specification, word for word, and it is the
   * whole difference between the two settings.
   */
  normal: {
    label: 'Normal', aggression: 1.35, band: 0.12, playerSpeed: 1.0, grudge: 15,
    // Every AI number here is Hard's. `lift` is not an AI number - it is the
    // corner-braking aid on the *player's* own car - and the owner's rule was
    // about the rivals, so this one stays at Normal's own value. Taking it
    // away as well would have made Normal harder to drive than Hard for
    // anybody using Sport or Pro, which is the opposite of the whole point.
    assist: 1.0, lift: 0.35, fight: 1.0, defend: 1.0,
    aiSpeed: 0.95, aiCorner: 0.92,
    chaseSpeed: 1.10, chaseCorner: 1.10,
    // 20 km/h, in m/s. Applied to what a rival *aims* at, not to the limiter,
    // so it is a lift and not a wall - they carry on racing each other and
    // simply stop pulling away from you.
    concede: 20 / 3.6,
  },
  hard: {
    // `grudge` is *seconds*: how long they keep the extra pace after getting
    // back in front of you, wound down to nothing over exactly that time and
    // scattered per car. Fifteen is what the owner asked for - go past, hold
    // it, then come back to me.
    label: 'Hard', aggression: 1.35, band: 0.12, playerSpeed: 1.0, grudge: 15,
    assist: 1.0, lift: 0, fight: 1.0, defend: 1.0,
    // Cruises at Normal's pace so you can catch them and get by...
    aiSpeed: 0.95, aiCorner: 0.92,
    // ... and then comes after you properly. This is a fraction of the same
    // base the player is limited to, and 1.10 lands about 20 km/h above what
    // they actually reach on track once drag is paid - enough to hunt a leader
    // down without being able to drive away from them.
    // Both of these are worth more than they look: capping `chaseCorner` at
    // 1.02 - on the theory that above 1.0 it is asking for a slide rather than
    // pace - was tried and made Hard *weaker*, taking back 11 places over a
    // set of races instead of 17. A controlled slide out of a corner is how
    // this model finds the extra, so leave it above one.
    chaseSpeed: 1.10, chaseCorner: 1.10,
  },
};

export const QUALITY = {
  low: { label: 'Low', shadows: false, pixelRatio: 1, fog: 420, aniso: 1 },
  high: { label: 'High', shadows: true, pixelRatio: 2, fog: 900, aniso: 4 },
};

export const LAP_CHOICES = [2, 5, 10, 15, 20];

/**
 * The handling models a player may actually pick.
 *
 * Arcade is still in `PHYSICS` and still works - `simulate.mjs` races it, and
 * it is the only model with no grip limit at all - but it is no longer offered
 * anywhere. Racing against people wants a car that can be driven badly.
 */
export const PHYSICS_CHOICES = ['sport', 'pro'];

export function load() {
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
  })();
  const settings = { ...DEFAULTS, ...saved };
  // A phone that has played before has `easy` and `arcade` written into its
  // storage, and neither has a button any more. Coerce rather than leave
  // somebody on a setting they cannot see or change.
  settings.difficulty = 'hard';
  if (!PHYSICS_CHOICES.includes(settings.physics)) settings.physics = DEFAULTS.physics;
  return settings;
}

export function save(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* private mode - settings just will not persist */
  }
}
