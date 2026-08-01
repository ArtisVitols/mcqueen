import { MAX_PSI } from './car.js';

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

export class Driver {
  constructor(car, spec, rng) {
    this.car = car;
    this.baseLane = spec.lane;
    this.lane = spec.lane;
    this.pace = spec.pace;
    this.aggression = spec.aggression;
    this.rng = rng;
    this.commit = 0;          // seconds left on the current overtake
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
    let want = idle;

    if (ahead && this.commit <= 0 && aheadGap < 30) {
      const closing = car.speed - ahead.speed;
      const keen = this.aggression * tuning.aggression;
      if (closing > -1.5 && this.rng() < keen * dt * 4) {
        // Prefer the inside - it is the shorter way round - then the outside.
        if (!blockedInside) {
          want = car.n - 4.5;
          this.commit = 2.4;
        } else if (!blockedOutside) {
          want = car.n + 4.5;
          this.commit = 2.4;
        }
        this.lane = want;
      }
    } else if (this.commit > 0) {
      want = this.lane;
    }

    // Once past, drift back to the preferred line.
    if (this.commit <= 0) this.lane += (idle - this.lane) * Math.min(1, dt * 0.5);

    const st = track.sample(car.s, car.st);
    const target = clamp(want, track.limit(st, -1) + 1.5, track.limit(st, 1) - 1.5);

    // --- steer towards the target lane ------------------------------------
    // Aim for a heading that closes the gap over roughly a second, then let
    // the car's own steering model get there.
    const wantPsi = clamp(Math.atan2(target - car.n, Math.max(12, car.speed)), -MAX_PSI, MAX_PSI);
    // Straight proportional control works when the heading *is* the command.
    // Where the heading is a state with inertia behind it, the same gain
    // oscillates and then spins the car, so damp on the yaw rate instead.
    car.steer = physics?.yawModel
      ? clamp((wantPsi - car.psi) * 1.5 - (car.yawRate || 0) * 1.1, -1, 1)
      : clamp((wantPsi - car.psi) * 2.6, -1, 1);

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
    // job. Nobody wins a race spinning, so the AI backs off the moment it
    // feels the rear go.
    if (physics?.yawModel) {
      car.throttle *= Math.max(0.15, 1 - Math.abs(car.vy) / 4);
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
