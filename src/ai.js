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
const SAME_LANE = 2.4;      // ... and how close is still *behind* them

// Chasing a human. `fight` is 0..1 and it is *on while a human is ahead of
// this car*: it winds up over a second and a half, and while it is up the
// driver has more pace than the player has, more corner commitment, a better
// tow and more appetite for a move. Getting back in front of them is what
// winds it down again.
//
// Race.rubberBand remains the global "keep the pack catchable" control; these
// two do different jobs and the band stands down for a car that is chasing.
// How far ahead a human can be and still be worth chasing, as a fraction of a
// lap.
//
// It has been raised twice, and for the same reason both times: a fixed 60 m,
// then a fixed 240 m, and in both cases a player who got clear simply drove
// out of range and the entire field relaxed and let them go - which is the
// one thing this is supposed to prevent. Half a lap is not a tuning value, it
// is the point past which "ahead of me" stops meaning anything at all, so
// this now says what it always meant: **chase while a human is ahead of you.**
// The cap is only there to stop a car that is being lapped from chasing the
// leader it can see in its mirrors.
const FIGHT_FORGET = 0.45;      // of a lap
const FIGHT_RISE = 1.5;     // seconds to wind up to full chase
/**
 * Seconds a rival stays angry once it is back in front of you, wound down to
 * nothing over exactly that time. Per-difficulty, because how long they stay
 * angry is as much of a dial as how fast they go while they are.
 *
 * It used to be a *halflife*, which is not the same shape at all: half the
 * grudge is still most of the pace, so a rival that had passed you kept the
 * extra 20 km/h for the best part of a minute and simply left. What the owner
 * asked for is that they go past, hold it for about fifteen seconds, and then
 * come back to you - so this is a duration and the wind-down is linear.
 */
const FIGHT_FADE = 10;
/**
 * ... and no two of them do it together.
 *
 * Each driver gets its own fraction of the difficulty's figure, drawn once at
 * the start. A field that all stands down on the same frame reads as a switch
 * being thrown, which is exactly what it would be.
 */
const FADE_SPREAD = 0.4;    // +/- this fraction, per car
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

/**
 * How much of a car's own pace is drawn fresh each race.
 *
 * `spec.pace` is the car's *character* - Mater is slow because Mater is slow,
 * every time - and this is the bit on top that makes one race different from
 * the next. Small on purpose: big enough that the order the field settles into
 * is not the same every time, small enough that it never reorders the ladder
 * around it. Mater sits clear of the rest of the field for that reason: a
 * jitter that could lift the slowest car past somebody would make "the tow
 * truck is the slowest" a thing that is usually true, which is not the same
 * thing at all.
 */
const PACE_JITTER = 0.025;
/**
 * ... and no rival is ever quicker than a person, at its cruising pace.
 *
 * The margin itself comes from `aiSpeed` being below `playerSpeed` on every
 * difficulty, which is 5% on Normal and Hard and 12% on Easy. This is only
 * here so that a `pace` typed above 1 in cars.json cannot quietly take that
 * away - the chase pace is allowed above the player, and nothing else is.
 */
const PACE_CEILING = 1.0;

export class Driver {
  constructor(car, spec, rng) {
    this.car = car;
    this.baseLane = spec.lane;
    this.lane = spec.lane;
    this.pace = Math.min(PACE_CEILING, spec.pace) *
                (1 + (rng() * 2 - 1) * PACE_JITTER);
    this.aggression = spec.aggression;
    this.rng = rng;
    this.commit = 0;          // seconds left on the current overtake
    this.cool = 0;            // ... and before another may be started
    this.fight = 0;           // 0..1, how hard it is chasing a human
    this.defend = 0;          // seconds left holding a covered line
    this.defendCool = 0;
    this.wander = rng() * Math.PI * 2;
    // How long *this* driver stays angry, as a fraction of the difficulty's
    // figure. Drawn once, so it is the same car every time within a race and a
    // different one between races.
    this.fadeScale = 1 + (rng() * 2 - 1) * FADE_SPREAD;
  }

  /**
   * Am I behind a human right now?
   *
   * Only humans count: an AI chasing another AI is churn nobody sees, and the
   * point of this is to make *your* race harder.
   */
  updateFight(dt, field, tuning) {
    const car = this.car;
    let chasing = false;
    let nearest = Infinity;

    const forget = car.track.lapLength * FIGHT_FORGET;
    for (const other of field) {
      if (!other.isPlayer || other.finished) continue;
      const gap = other.progress - car.progress;      // positive: they are ahead
      if (Math.abs(gap) < nearest) nearest = Math.abs(gap);
      // Behind them, and on the same lap as them.
      if (gap > 0 && gap < forget) chasing = true;
    }

    // The whole rule, and it is deliberately this simple: **chase while a
    // human is ahead of you.** Not "for ten seconds after being passed" -
    // that faded whether or not you were still in front, so once you were by
    // everybody the field quietly gave up and you cruised away unopposed.
    //
    // Being ahead of them is what switches it off again, which is exactly the
    // shape the owner asked for: pass the lot, they come after you; one of
    // them gets by, that one settles down.
    const ceiling = tuning.fight ?? 0;
    if (chasing && nearest < forget) {
      this.fight += (ceiling - this.fight) * Math.min(1, dt / FIGHT_RISE);
    } else {
      // Straight down to nothing over the driver's own fade time, so a rival
      // that has got back in front holds the extra pace for that long and is
      // then exactly as quick as it was on lap one - which is when the rubber
      // band starts reeling it back to you again.
      this.fight -= dt / ((tuning.grudge ?? FIGHT_FADE) * this.fadeScale);
      // Snap the tail to zero, but only on the way *down*. Applied to a value
      // that is winding up, this floor eats the first increment of every step
      // - which is smaller than the floor - and the grudge never leaves zero.
      if (this.fight < 0.01) this.fight = 0;
    }
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
    // Pace is the difficulty's cruising figure while this driver is ahead of
    // you, and its chasing figure while it is behind you. On Hard that is the
    // whole difference between the two settings: you catch them at Normal's
    // pace, and the moment you are by they find about 20 km/h more than you
    // have and come and take it back.
    //
    // `baseSpeed` carries the rubber band and nothing else; the pace figure is
    // applied here so the grudge can move it. `topSpeed` is only the limiter.
    let targetSpeed = (car.baseSpeed ?? car.topSpeed) * this.pace *
                      paced(tuning, 'aiSpeed', 'chaseSpeed', this.fight);

    // Drafting: tucked in behind someone is worth real speed on a superspeedway.
    if (ahead && aheadGap < DRAFT_RANGE && Math.abs(ahead.n - car.n) < 2.5) {
      targetSpeed *= 1 + (0.07 + FIGHT_TOW * this.fight) * (1 - aheadGap / DRAFT_RANGE);
    }
    // Do not drive through the back of the car in front - but only while
    // actually behind it.
    //
    // `SIDE_CLEAR` is 3.6 m and a move aims `PASS_GAP` 3.4 m to the side, so a
    // driver that had *completed* its move and was running alongside still
    // counted the other car as being in front of it, and went on lifting to
    // 92% of its speed. It could draw level and never get by, all race. The
    // lane here is deliberately narrower than the one that spots traffic:
    // seeing somebody is not the same as being stuck behind them.
    if (ahead && aheadGap < 11 && Math.abs(ahead.n - car.n) < SAME_LANE) {
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
