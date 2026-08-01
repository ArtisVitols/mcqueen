import { laneSteer } from './physics.js';

/**
 * Opponent driver logic.
 *
 * Each AI holds a preferred lane and steers towards it, which is all it takes
 * to run a clean racing line once the car is in track space. On top of that it
 * does the three things that make an oval race look like an oval race: it
 * drafts the car in front, it dives to the inside or swings wide to pass, and
 * it lifts rather than driving through the back of someone.
 */

const LOOK_AHEAD = 42;      // metres of track scanned for traffic
const SIDE_CLEAR = 3.6;     // lateral gap that counts as "occupied"
const DRAFT_RANGE = 34;
const CAR_LENGTH = 5;
const PASS_GAP = 3.4;       // how far beside the car being passed to aim

export class Driver {
  constructor(car, spec, rng) {
    this.car = car;
    this.baseLane = spec.lane;
    this.lane = spec.lane;
    this.pace = spec.pace;
    this.aggression = spec.aggression;
    this.rng = rng;
    this.commit = 0;          // seconds left on the current overtake
    this.cool = 0;            // ... and before another may be started
    this.wander = rng() * Math.PI * 2;
  }

  /**
   * @param {Car[]} field     every car in the race
   * @param {object} tuning   difficulty settings
   * @param {object} physics  the handling model, for its corner-speed limit
   */
  update(dt, field, tuning, physics = null) {
    const car = this.car;
    const track = car.track;

    // Slow drift of the preferred lane so the pack breathes instead of
    // running on rails.
    this.wander += dt * 0.35;
    const idle = this.baseLane + Math.sin(this.wander) * 0.8;

    // --- find the car we are closing on ----------------------------------
    let ahead = null;
    let aheadGap = Infinity;
    let blockedInside = false;
    let blockedOutside = false;

    for (const other of field) {
      if (other === car) continue;
      const gap = track.delta(car.s, other.s);
      if (gap > -CAR_LENGTH * 1.6 && gap < LOOK_AHEAD) {
        const dn = other.n - car.n;
        if (Math.abs(dn) < SIDE_CLEAR && gap > 0 && gap < aheadGap) {
          ahead = other;
          aheadGap = gap;
        }
        // Anything alongside or just ahead closes off that lane.
        if (gap < 22) {
          if (dn < -1.2 && dn > -9) blockedInside = true;
          if (dn > 1.2 && dn < 9) blockedOutside = true;
        }
      }
    }

    // --- choose a lane ----------------------------------------------------
    this.commit = Math.max(0, this.commit - dt);
    this.cool = Math.max(0, this.cool - dt);

    if (ahead && this.commit <= 0 && this.cool <= 0 && aheadGap < 30) {
      // Only pull out for someone you are actually catching. Diving on a car
      // going the same speed just means sitting alongside it and coming back.
      const closing = car.speed - ahead.speed;
      const keen = this.aggression * tuning.aggression;
      if (closing > 0.5 && this.rng() < keen * dt * 2) {
        // Aim beside the car being passed, not a fixed distance from wherever
        // this car happens to be - repeating the latter walks the car across
        // the track a lane at a time.
        if (!blockedInside) this.lane = ahead.n - PASS_GAP;
        else if (!blockedOutside) this.lane = ahead.n + PASS_GAP;
        this.commit = 3.0;
      }
    }
    let want;
    if (this.commit > 0) {
      want = this.lane;
    } else {
      // Drift back to the preferred line, then wait before trying again. The
      // cooldown is the difference between racing and weaving: without it a
      // car dives, returns over about two seconds, and immediately dives
      // again, which is exactly the four-second wave the whole field was
      // doing down Palm Mile's straights.
      if (this.lane !== idle && Math.abs(this.lane - idle) > 0.05 && this.cool <= 0) {
        this.cool = 2.5 + this.rng() * 2.5;
      }
      this.lane += (idle - this.lane) * Math.min(1, dt * 0.6);
      want = this.lane;
    }

    // Keep off the very edge: the corridor already reserves half a car, and a
    // driver aiming at the last centimetre of it spends the lap on the clamp.
    const st = track.sample(car.s, car.st);
    const target = clamp(want, track.limit(st, -1) + 1.5, track.limit(st, 1) - 1.5);
    car.steer = laneSteer(car, target, dt);

    // --- throttle ---------------------------------------------------------
    let targetSpeed = car.topSpeed * this.pace;

    // Drafting: tucked in behind someone is worth real speed on a superspeedway.
    if (ahead && aheadGap < DRAFT_RANGE && Math.abs(ahead.n - car.n) < 2.5) {
      targetSpeed *= 1 + 0.07 * (1 - aheadGap / DRAFT_RANGE);
    }
    // Do not drive through the back of the car in front.
    if (ahead && aheadGap < 11) {
      targetSpeed = Math.min(targetSpeed, ahead.speed * (0.85 + 0.015 * aheadGap));
    }
    // A touch of lift through the banking. Kept small on purpose: under the
    // arcade model the turns are flat-out, and anything more hands a
    // throttle-pinned player an easy win on every difficulty.
    targetSpeed *= 1 - Math.min(0.035, Math.abs(st.kappa) * 1000 * 0.008);

    // Under a model with real grip the corner has an actual speed limit, and
    // driving past it just means sliding up to the wall. Rivals stay a little
    // inside it. Arcade returns Infinity, so its pace is untouched.
    if (physics) {
      const limit = physics.cornerSpeed(car, st, car.n);
      if (limit < Infinity) {
        targetSpeed = Math.min(targetSpeed, limit * (tuning.aiCorner ?? 0.94) * (car.paceScale ?? 1));
      }
    }

    const err = targetSpeed - car.speed;
    car.throttle = clamp(err * 0.5, 0, 1);
    car.brake = clamp(-err * 0.12, 0, 1);

    // Feeding in more power while the tail is already out just finishes the
    // job, so the AI backs off when it feels the rear go. Keyed on how fast
    // the car is *rotating*, not on how far it is sliding: at the limit every
    // car slides a few metres a second, and reading that as trouble had the
    // whole field creeping round the lap on a sixth of a throttle.
    if (physics?.yawModel) {
      car.throttle *= Math.max(0.4, 1 - Math.abs(car.yawRate || 0) * 0.9);
    }
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Deterministic PRNG so a race can be replayed and tested. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
