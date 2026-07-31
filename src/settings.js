const KEY = 'mcqueen-speedway';

const DEFAULTS = {
  car: 'lightning_mcqueen',
  laps: 3,
  quality: 'high',
  difficulty: 'easy',
  sound: true,
  volume: 0.8,
};

/** AI behaviour per difficulty. Easy keeps the pack catchable for a five-year-old. */
export const DIFFICULTY = {
  easy: { label: 'Easy', aiSpeed: 0.88, aggression: 0.55, band: 0.7, playerSpeed: 1.0 },
  normal: { label: 'Normal', aiSpeed: 0.985, aggression: 1.0, band: 0.3, playerSpeed: 1.0 },
  hard: { label: 'Hard', aiSpeed: 1.06, aggression: 1.35, band: 0.0, playerSpeed: 1.0 },
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
