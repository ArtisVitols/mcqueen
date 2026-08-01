import { laneSteer, COMMITTED_CLOSE } from './physics.js';

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

// Being overtaken by a human. `fight` is a grudge: it rises the moment they
// get by and decays over the next ten seconds or so, and while it is up this
// driver has more pace, more corner speed and more appetite for a move. It is
// deliberately a *duel* with the car that just passed - Race.rubberBand
// remains the global "keep the pack catchable" control, and the two do
// different jobs.
const FIGHT_RANGE = 25;     // metres; closer than this and a pass is personal
const FIGHT_FORGET = 60;    // ... and past this they give up and settle down
// Seconds for the grudge to halve. Per-difficulty, because how long a rival
// stays angry is as much of a dial as how fast it goes when it is: a short
// grudge means they attack, fade, and you cruise away from them.
const FIGHT_HALFLIFE = 8;
const FIGHT_TOW = 0.05;     // a better tow while the grudge is up

/** Blend between a difficulty's cruising value and its chasing one. */
function paced(tuning, cruise, chase, fight) {
  const a = tuning[cruise] ?? 1;
  const b = tuning[chase] ?? a;
  return a + (b - a) * fight;
}

// Covering the line. One move to take the inside before the challenger
// commits, held for a couple of seconds, then a cooldown. Never a reaction to
// where they have already got to: the moment they are alongside this driver
// concedes the line and races them side by side. That is the difference
// between hard to pass and cheap to lose to.
const DEFEND_RANGE = 15;    // metres behind that counts as a threat
const DEFEND_STEP = 1.4;    // how far towards the inside the move goes
const DEFEND_HOLD = 2.5;    // seconds the covered line is held
const DEFEND_COOL = 4.0;    // ... before the line may be covered again

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
    this.fight = 0;           // 0..1 grudge against whoever just passed
    this.defend = 0;          // seconds left holding a covered line
    this.defendCool = 0;
    this.rel = new Map();     // human car -> where they were, to spot a pass
    this.wander = rng() * Math.PI * 2;
  }

  /**
   * Watch the humans go by.
   *
   * A pass is a change of sign in "how far ahead of me are they", close
   * enough that it happened here rather than a straight away. Only humans
   * count: an AI holding a grudge against another AI is churn nobody sees,
   * and the point of this is to make *your* race harder.
   */
  updateFight(dt, field, tuning) {
    const car = this.car;
    let nearest = Infinity;

    for (const other of field) {
      if (!other.isPlayer || other.finished) continue;
      const gap = other.progress - car.progress;      // positive: they are ahead
      const was = this.rel.get(other);
      this.rel.set(other, gap);
      nearest = Math.min(nearest, Math.abs(gap));
      if (was === undefined) continue;
      if (was < 0 && gap >= 0 && Math.abs(gap) < FIGHT_RANGE) {
        this.fight = Math.min(1, this.fight + (tuning.fight ?? 0));
      }
    }

    this.fight *= Math.pow(0.5, dt / (tuning.grudge ?? FIGHT_HALFLIFE));
    // Out of reach, so stop chasing. Without this a driver hounds a player who
    // is half a lap up, which is neither realistic nor any fun to be behind.
    if (nearest > FIGHT_FORGET) this.fight = 0;
    if (this.fight < 0.01) this.fight = 0;
    // Race.rubberBand reads this off the car. Without it the handicap that
    // keeps the pack catchable would reel in the one car that is trying to
    // come back at you, which is the opposite of the point.
    car.fight = this.fight;
  }

  /**
   * @param {Car[]} field     every car in the race
   * @param {object} tuning   difficulty settings
   * @param {object} physics  the handling model, for its corner-speed limit
   */
  update(dt, field, tuning, physics = null) {
    const car = this.car;
    const track = car.track;

    this.updateFight(dt, field, tuning);

    // Slow drift of the preferred lane so the pack breathes instead of
    // running on rails.
    this.wander += dt * 0.35;
    const idle = this.baseLane + Math.sin(this.wander) * 0.8;

    // --- find the car we are closing on ----------------------------------
    let ahead = null;
    let aheadGap = Infinity;
    let blockedInside = false;
    let blockedOutside = false;
    let chall = null;          // the human closing on us from behind
    let challGap = Infinity;

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
      if (other.isPlayer && !other.finished && gap < 0 && -gap < challGap &&
          -gap < DEFEND_RANGE && other.speed > car.speed) {
        chall = other;
        challGap = -gap;
      }
    }

    // --- choose a lane ----------------------------------------------------
    this.commit = Math.max(0, this.commit - dt);
    this.cool = Math.max(0, this.cool - dt);
    this.defend = Math.max(0, this.defend - dt);
    this.defendCool = Math.max(0, this.defendCool - dt);

    // Concede the moment they are alongside. Holding a line against a car that
    // is already there is not defending, it is driving into them.
    if (chall && challGap < CAR_LENGTH) this.defend = 0;

    // Cover the inside before they commit - one move, then leave it alone.
    if (chall && (tuning.defend ?? 0) > 0 && this.defend <= 0 &&
        this.defendCool <= 0 && this.commit <= 0 && challGap > CAR_LENGTH) {
      const inside = Math.min(car.n, chall.n) - DEFEND_STEP * (tuning.defend ?? 0);
      this.lane = inside;
      this.defend = DEFEND_HOLD;
      this.defendCool = DEFEND_COOL;
    }

    if (ahead && this.commit <= 0 && this.cool <= 0 && aheadGap < 30) {
      // Only pull out for someone you are actually catching. Diving on a car
      // going the same speed just means sitting alongside it and coming back.
      //
      // Unless there is a grudge, and then pull out regardless: a car sitting
      // right behind the one that just passed it can never *be* closing,
      // because the same code lifts to avoid driving through the back of them.
      // Requiring closing speed to attempt a move therefore locked a rival
      // into second place the instant it lost first, which is exactly the
      // fight-back that is supposed to happen here.
      const closing = car.speed - ahead.speed;
      const keen = this.aggression * tuning.aggression * (1 + this.fight);
      if ((closing > 0.5 || this.fight > 0.3) && this.rng() < keen * dt * 2) {
        // Aim beside the car being passed, not a fixed distance from wherever
        // this car happens to be - repeating the latter walks the car across
        // the track a lane at a time.
        if (!blockedInside) this.lane = ahead.n - PASS_GAP;
        else if (!blockedOutside) this.lane = ahead.n + PASS_GAP;
        this.commit = 3.0;
      }
    }
    let want;
    if (this.commit > 0 || this.defend > 0) {
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
    // A move being committed to is made briskly; drifting back to the racing
    // line afterwards is not.
    const committed = this.commit > 0 || this.defend > 0;
    car.steer = laneSteer(car, target, dt, committed ? COMMITTED_CLOSE : null);

    // --- throttle ---------------------------------------------------------
    // Pace is the difficulty's cruising figure until somebody passes this
    // driver, and its chasing figure for the ten seconds afterwards. On Hard
    // that is the whole difference between the two settings: you catch them at
    // Normal's pace, and once you are by they show you what Hard means.
    //
    // `baseSpeed` carries the rubber band and nothing else; the pace figure is
    // applied here so the grudge can move it. `topSpeed` is only the limiter.
    let targetSpeed = (car.baseSpeed ?? car.topSpeed) * this.pace *
                      paced(tuning, 'aiSpeed', 'chaseSpeed', this.fight);

    // Drafting: tucked in behind someone is worth real speed on a superspeedway.
    if (ahead && aheadGap < DRAFT_RANGE && Math.abs(ahead.n - car.n) < 2.5) {
      targetSpeed *= 1 + (0.07 + FIGHT_TOW * this.fight) * (1 - aheadGap / DRAFT_RANGE);
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
        const commitment = paced(tuning, 'aiCorner', 'chaseCorner', this.fight);
        targetSpeed = Math.min(targetSpeed, limit * commitment * (car.paceScale ?? 1));
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
