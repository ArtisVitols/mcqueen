const KEY = 'mcqueen-speedway';

const DEFAULTS = {
  car: 'lightning_mcqueen',
  track: 'msots',
  laps: 5,
  quality: 'high',
  difficulty: 'easy',
  physics: 'arcade',
  // How much the car drives itself in a two-player race. Each player keeps
  // their own; the AI's difficulty belongs to whoever is hosting.
  help: 'easy',
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
  normal: {
    label: 'Normal', aggression: 1.0, band: 0.3, playerSpeed: 1.0,
    assist: 1.0, lift: 0.35, fight: 0.7, defend: 0.15,
    aiSpeed: 0.95, aiCorner: 0.92,
    chaseSpeed: 1.00, chaseCorner: 0.98,
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
    chaseSpeed: 1.10, chaseCorner: 1.10,
  },
};

export const QUALITY = {
  low: { label: 'Low', shadows: false, pixelRatio: 1, fog: 420, aniso: 1 },
  high: { label: 'High', shadows: true, pixelRatio: 2, fog: 900, aniso: 4 },
};

export const LAP_CHOICES = [2, 5, 10, 15, 20];

export function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function save(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* private mode - settings just will not persist */
  }
}
