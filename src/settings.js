const KEY = 'mcqueen-speedway';

const DEFAULTS = {
  car: 'lightning_mcqueen',
  track: 'msots',
  laps: 3,
  quality: 'high',
  difficulty: 'easy',
  physics: 'arcade',
  sound: true,
  volume: 0.8,
};

/**
 * AI behaviour per difficulty. Easy keeps the pack catchable for a five-year-old.
 *
 * `assist` is a grip multiplier for the player only. It does nothing under
 * Arcade, which has no grip model, and exists so that Easy stays winnable by
 * holding the throttle down whichever handling model is selected - a small
 * child can tap any entry in the menu, and must not end up stuck. `lift` is
 * the matching corner-braking aid: grip alone cannot save a driver who never
 * lifts, so on Easy the car slows itself for the turns. `aiCorner` is the
 * other half of the same problem: under a grip model the rivals' pace is set
 * by how hard they corner, not by `aiSpeed`, so that is what Easy has to turn
 * down.
 */
export const DIFFICULTY = {
  easy: {
    label: 'Easy', aiSpeed: 0.88, aggression: 0.55, band: 0.7, playerSpeed: 1.0,
    assist: 1.9, lift: 1.0, aiCorner: 0.88,
  },
  normal: {
    label: 'Normal', aiSpeed: 0.985, aggression: 1.0, band: 0.3, playerSpeed: 1.0,
    assist: 1.1, lift: 0.35, aiCorner: 0.96,
  },
  hard: {
    label: 'Hard', aiSpeed: 1.06, aggression: 1.35, band: 0.0, playerSpeed: 1.0,
    assist: 1.0, lift: 0, aiCorner: 1.0,
  },
};

export const QUALITY = {
  low: { label: 'Low', shadows: false, pixelRatio: 1, fog: 420, aniso: 1 },
  high: { label: 'High', shadows: true, pixelRatio: 2, fog: 900, aniso: 4 },
};

export const LAP_CHOICES = [1, 3, 5];

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
