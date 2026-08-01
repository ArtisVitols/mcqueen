import * as THREE from 'three';

/**
 * The three handling models.
 *
 * `Car` owns everything that keeps the game coherent - integration in track
 * space, the heading clamp, track limits, lap counting - and delegates only the
 * forces to one of these. A model can therefore change how the car feels
 * without being able to break lap counting or put a car outside the corridor.
 *
 * Each model provides:
 *   maxPsi      heading clamp it runs under; `Car` still applies it
 *   steerRamp   rad/s the steer input ramps at, or 0 for the raw button
 *   wallScrub   speed kept per second while leaning on the wall
 *   drive(car, st, dt)        sets speed, psi, vy, slip, rev, gear
 *   cornerSpeed(car, st, n)   grip-limited speed, or Infinity - the AI's cap
 */

const clamp = THREE.MathUtils.clamp;
const G = 9.81;

/* -------------------------------------------------------------- arcade -- */

const A_STEER_RATE = 1.9;             // rad/s of heading change at full lock
const A_STEER_RETURN = 2.6;           // self-centring rate
const A_ENGINE = 15.0;                // m/s^2 at full throttle
const A_BRAKE = 22.0;
const A_DRAG = 0.00055;               // quadratic, sets the top speed
const A_ROLL_DRAG = 0.6;

/**
 * The original model, unchanged.
 *
 * There are no tyre forces at all: the steer input integrates straight into
 * the heading, and because the track tangent rotates underneath it a player who
 * only holds the throttle follows the oval by themselves. Cornering costs
 * nothing and the banking is decoration. That is the point - it is what makes
 * the game playable by a five-year-old, and it is why this stays the default.
 */
const arcade = {
  id: 'arcade',
  label: 'Arcade',
  blurb: 'Hold the gas. The car follows the track.',
  maxPsi: 0.87,                       // ~50 degrees off the tangent
  steerRamp: 0,
  wallScrub: 0.55,

  drive(car, st, dt) {
    const drag = A_DRAG * car.speed * car.speed + A_ROLL_DRAG;
    const accel = car.throttle * A_ENGINE * powerCurve(car) - car.brake * A_BRAKE - drag;
    car.speed = Math.max(0, car.speed + accel * dt);

    // Authority fades in from a standstill and tapers at speed, so the car
    // feels planted on the straights without going numb in the corners.
    const grip = Math.min(1, car.speed / 12) *
                 (0.45 + 0.55 * (1 - Math.min(1, car.speed / 110)));
    car.psi += car.steer * A_STEER_RATE * grip * dt;
    if (Math.abs(car.steer) < 0.05) {
      car.psi -= car.psi * Math.min(1, A_STEER_RETURN * dt);
    }

    // Car derives the squeal from the sideways movement it integrates, which
    // is all this model has; nothing extra to report.
    car.slip = 0;
    car.rev = car.topSpeed > 0 ? car.speed / car.topSpeed : 0;
    car.gear = 0;
  },

  cornerSpeed() {
    return Infinity;                  // nothing binds, which is the whole idea
  },
};

/** Torque falls away near the top end so acceleration tapers off. */
function powerCurve(car) {
  const r = car.speed / car.topSpeed;
  return Math.max(0.15, 1.25 - 0.85 * r * r);
}

/* ------------------------------------------------------- grip modelling -- */

// Mechanical grip, plus downforce that grows with speed. These are tuned, not
// looked up: these circuits turn out to be short ovals - 63 m corner radius on
// Motor Speedway, 99 m on Palm Mile, 255 m on Yoyleland - so an honest slicks
// figure would have the cars crawling round the first two. What these numbers
// buy is the right *shape*: Yoyleland, the one real superspeedway here, stays
// flat out, and the two short tracks need the driver to lift.
const MU_MECH = 1.35;
const MU_AERO = 0.9;                  // extra mu at V_AERO
const V_AERO = 78;                    // m/s the aero figure is quoted at
const GRIP_CAP = 45;                  // m/s^2, about 4.5 g

/**
 * Lateral acceleration the tyres can hold, in m/s^2.
 *
 * `bank` is dy/dn - the measured cross-slope at the car's own lane, which is
 * why the high line genuinely grips better while the low line stays shorter.
 * That trade-off is the whole reason the profile is measured per lane.
 */
function gripLimit(v, bank, assist = 1) {
  const mu = (MU_MECH + MU_AERO * (v / V_AERO) ** 2) * assist;
  // Standard banked-corner limit. It genuinely goes to infinity once
  // mu*tan(bank) reaches 1 - on Yoyleland's 18 degrees that happens - so it is
  // capped. The cap is high enough that Yoyleland stays flat out either way;
  // it is there to keep an unbounded number out of the friction circle.
  return Math.min(GRIP_CAP, G * (mu + bank) / Math.max(0.25, 1 - mu * bank));
}

/** Fastest speed that still holds the line at (st, n). Iterated: grip grows with v. */
function cornerSpeedAt(car, st, n) {
  const kappa = Math.abs(st.kappa);
  if (kappa < 1e-6) return Infinity;
  const bank = car.track.slope(st, n);
  let v = car.topSpeed;
  for (let i = 0; i < 4; i++) {
    v = Math.sqrt(gripLimit(v, bank, car.assist) / kappa);
  }
  return v;
}

/* --------------------------------------------------------------- gears -- */

// Six speeds. The ratios only shape how the torque arrives - the rev limiter
// in Car.step still sets the actual top speed, so difficulty keeps working.
const GEAR_TOP = [14, 26, 39, 52, 65, 999];
const GEAR_RATIO = [2.55, 1.85, 1.45, 1.20, 1.04, 0.92];
const SHIFT_CUT = 0.14;               // seconds of no drive across a change

function gearbox(car, dt) {
  car.shiftT = Math.max(0, (car.shiftT || 0) - dt);
  let g = car.gear | 0;
  // A little hysteresis, or the car hunts between two gears on the limiter.
  while (g < GEAR_TOP.length - 1 && car.speed > GEAR_TOP[g]) { g++; car.shiftT = SHIFT_CUT; }
  while (g > 0 && car.speed < GEAR_TOP[g - 1] * 0.88) { g--; car.shiftT = SHIFT_CUT; }
  car.gear = g;

  const bot = g > 0 ? GEAR_TOP[g - 1] : 0;
  const top = Math.min(GEAR_TOP[g], car.topSpeed * 1.02);
  car.rev = clamp((car.speed - bot) / Math.max(1, top - bot), 0.08, 1);
  // Torque peaks around three-quarter revs and falls away past it.
  const torque = 0.70 + 0.62 * car.rev - 0.48 * car.rev * car.rev;
  return car.shiftT > 0 ? 0 : GEAR_RATIO[g] * torque;
}

/* --------------------------------------------------------------- sport -- */

const S_ENGINE = 11.0;                // multiplied by the gear ratio
const S_BRAKE = 26.0;
const S_DRAG = 0.00055;
const S_ROLL_DRAG = 0.6;
const S_STEER_RATE = 1.55;
const S_STEER_RETURN = 2.4;
const VY_GRIP_BACK = 3.2;             // how fast the tyres claw a slide back

/**
 * Grip-limited, but it still cannot spin.
 *
 * The heading follows the driver's steering as before; what is new is that the
 * *velocity* no longer has to follow the heading. When the tyres cannot supply
 * the force needed to hold the line, the shortfall goes into `car.vy` and the
 * car slides outward while still pointing into the corner - which is what
 * understeer actually looks like. Lift and the slide comes back.
 */
const sport = {
  id: 'sport',
  label: 'Sport',
  blurb: 'Real grip. Lift for the turns, use the banking.',
  maxPsi: 0.87,
  steerRamp: 5.5,
  wallScrub: 0.30,
  assisted: true,               // the driver aids apply under this model
  geared: true,

  drive(car, st, dt) {
    const v = Math.max(car.speed, 0.001);
    const bank = car.track.slope(st, car.n);
    const grip = gripLimit(v, bank, car.assist);

    // --- steering ---------------------------------------------------------
    // Braking loads the front and helps it turn in; power unloads it. This is
    // a proxy for weight transfer, not a four-wheel model, and is deliberately
    // small - it should be felt, not fought.
    const transfer = 1 + 0.28 * car.brake - 0.18 * car.throttle;
    const authority = Math.min(1, v / 10) * (0.5 + 0.5 * (1 - Math.min(1, v / 130)));
    car.psi += car.steer * S_STEER_RATE * authority * transfer * dt;
    if (Math.abs(car.steer) < 0.05) {
      car.psi -= car.psi * Math.min(1, S_STEER_RETURN * dt);
    }

    // --- the friction circle ---------------------------------------------
    // Outward-positive centrifugal demand. Rotating the heading outwards at
    // `psiDot` unwinds part of the track's own curvature, which is why a car
    // that turns out of the corner needs less grip, not more.
    const psiDot = (car.psi - (car.psiPrev ?? car.psi)) / dt;
    car.psiPrev = car.psi;
    const demand = v * v * st.kappa - v * psiDot;
    const shortfall = Math.abs(demand) - grip;

    if (shortfall > 0) {
      // More than the tyres have. The rest accelerates the car sideways.
      car.vy += Math.sign(demand) * shortfall * dt;
    }
    car.vy -= car.vy * Math.min(1, VY_GRIP_BACK * dt);

    const used = Math.min(grip, Math.abs(demand));
    car.slip = Math.min(1, Math.abs(car.vy) / 5 + Math.max(0, used / grip - 0.85) * 2);

    // --- longitudinal ------------------------------------------------------
    // Whatever the tyres have left after cornering. Braking into a corner is
    // therefore genuinely less effective, and weaving down a straight costs
    // acceleration.
    const longMax = Math.sqrt(Math.max(0, grip * grip - used * used));
    const drive = Math.min(car.throttle * S_ENGINE * gearbox(car, dt), longMax);
    const stop = Math.min(car.brake * S_BRAKE, longMax);
    const drag = S_DRAG * v * v * (1 - 0.22 * (car.draft || 0)) + S_ROLL_DRAG;
    // Induced drag: the work going sideways comes out of the car's momentum,
    // which is what makes running wide cost time. It scales with the force the
    // tyres are actually making - charging the whole grip budget taxed a car
    // for cornering easily on a well banked track.
    const slideDrag = used * Math.abs(car.vy) / v;

    car.speed = Math.max(0, car.speed + (drive - stop - drag - slideDrag) * dt);
  },

  cornerSpeed(car, st, n) {
    return cornerSpeedAt(car, st, n);
  },
};

/* ----------------------------------------------------------------- pro -- */

const P_STEER_LOCK = 0.50;            // radians of front wheel angle at full lock
const P_A = 1.46;                     // metres, centre of mass to the front axle
const P_B = 1.24;                     // ... and to the rear
const P_IZ = 1.60;                    // yaw inertia over mass, m^2
// Cornering stiffness per unit mass, m/s^2 per radian of slip. Sized so the
// tyres saturate around a tenth of a radian, which is where real ones give up.
const P_CS_FRONT = 180;
const P_CS_REAR = 210;                // rear stiffer than front: stable at heart
const P_V_REF = 8;                    // slip angles are meaningless below this
const P_RECOVER_PSI = 1.40;           // ~80 degrees, where the safety net starts

/**
 * Yaw dynamics: the rear can step out, and you have to catch it.
 *
 * `psi` stops being something the driver sets and becomes a state driven by
 * front and rear tyre forces. Power eats into the rear's lateral grip, so
 * getting on the throttle mid-corner swings the tail - and opposite lock is
 * the way out, because the front slip angle is what pulls it straight.
 *
 * Past `P_RECOVER_PSI` a straightening torque and a hard speed scrub take
 * over. A spin costs the race; it never ends with a car parked facing a wall,
 * which matters because the AI drives this model too and every car has to
 * finish.
 */
const pro = {
  id: 'pro',
  label: 'Pro',
  blurb: 'Loose rear. You can spin it.',
  maxPsi: 2.6,
  steerRamp: 4.0,
  wallScrub: 0.18,
  assisted: true,
  geared: true,
  yawModel: true,               // psi is a state here, not a command

  drive(car, st, dt) {
    const v = Math.max(car.speed, 0.001);
    // Slip angle is (lateral speed / forward speed), which is meaningless at a
    // standstill: the bicycle model is singular at v = 0. Floor the reference
    // speed and fade the tyres in, or the car sits on the grid sawing itself
    // sideways with the friction circle leaving nothing to drive with.
    const vRef = Math.max(car.speed, P_V_REF);
    const fade = Math.min(1, car.speed / 6);
    const bank = car.track.slope(st, car.n);
    const grip = gripLimit(v, bank, car.assist);
    const delta = car.steer * P_STEER_LOCK * (1 - 0.45 * Math.min(1, v / 90));
    car.steerAngle = delta;

    // Everything here is outward-positive. The track tangent itself rotates
    // inward at kappa*v, so the car's yaw rate in the world is psiDot - kappa*v
    // - which is what makes a car that simply holds its heading follow the
    // corner.
    const r = car.yawRate || 0;
    const rWorld = r - st.kappa * v;

    const slipF = delta - (car.vy + P_A * rWorld) / vRef;
    const slipR = -(car.vy - P_B * rWorld) / vRef;

    // Power and braking eat the rear's lateral budget. This one line is the
    // whole reason the tail steps out when you get greedy with the throttle.
    const rearBudget = grip * Math.max(0.3, 1 - 0.5 * car.throttle - 0.25 * car.brake);
    const frontBudget = grip * (1 + 0.25 * car.brake);
    const fF = clamp(P_CS_FRONT * slipF, -frontBudget, frontBudget) * fade;
    const fR = clamp(P_CS_REAR * slipR, -rearBudget, rearBudget) * fade;

    car.vy += ((fF + fR) - v * rWorld) * dt;
    car.yawRate = (r + (P_A * fF - P_B * fR) / P_IZ * dt) * Math.pow(0.55, dt);
    car.psi += car.yawRate * dt;

    // The safety net. Not decoration: without it a spun car sits there and the
    // race never finishes - and the AI drives this model too.
    if (Math.abs(car.psi) > P_RECOVER_PSI) {
      const over = Math.abs(car.psi) - P_RECOVER_PSI;
      car.psi -= Math.sign(car.psi) * Math.min(Math.abs(car.psi), over * 3.5 * dt);
      car.yawRate *= Math.pow(0.02, dt);
      car.vy *= Math.pow(0.05, dt);
      car.speed *= Math.pow(0.25, dt);
    }

    const used = Math.min(grip, Math.abs(fF + fR));
    car.slip = Math.min(1, Math.abs(car.vy) / 4 + Math.abs(slipR) * 3);

    const longMax = Math.sqrt(Math.max(0, grip * grip - used * used));
    const drive = Math.min(car.throttle * S_ENGINE * gearbox(car, dt), longMax);
    const stop = Math.min(car.brake * S_BRAKE, longMax);
    const drag = S_DRAG * v * v * (1 - 0.22 * (car.draft || 0)) + S_ROLL_DRAG;
    const slideDrag = used * Math.abs(car.vy) / v;

    car.speed = Math.max(0, car.speed + (drive - stop - drag - slideDrag) * dt);
  },

  cornerSpeed(car, st, n) {
    // Rivals leave more in hand here, because a Pro-model AI that runs right on
    // the limit spins itself out of the race.
    return cornerSpeedAt(car, st, n) * 0.94;
  },
};

/* ----------------------------------------------------------- driver aid -- */

const AID_BRAKE = 22.0;                // m/s^2 the aid plans its braking at
const AID_LOOK = [0, 22, 48, 78, 112];
const AID_LANE_RATE = 3.2;            // m/s the steering moves the target lane

/**
 * Lifts, brakes and steers for the player.
 *
 * "Easy must be winnable by holding the throttle down and nothing else" is a
 * rule of this project, and a five-year-old can tap any entry in the physics
 * menu. Neither of the grip models can honour that on its own:
 *
 *  - Sport arrives at a 63 m corner doing 280, slides to the wall and scrubs
 *    there for half the turn.
 *  - Pro is worse. With tyre forces driving the heading, a car with no
 *    steering input cannot generate the inward force a corner needs at all -
 *    it simply understeers off. Holding the throttle is not a slow way round;
 *    it is not a way round.
 *
 * So Easy drives. The steering buttons still do something - they move the lane
 * the aid holds, which is how the arcade model already feels - and the aid
 * handles the rest. Normal gives a third of it, Hard none. Arcade has no grip
 * model to assist and is skipped entirely.
 *
 * @param {number} amount 0..1, how much of the aid to apply
 */
export function driverAid(car, amount, dt) {
  if (!(amount > 0) || !car.physics.assisted) return;
  const st = car._aidSt || (car._aidSt = {});

  // --- slow down for what is coming -------------------------------------
  let allowed = Infinity;
  for (const ahead of AID_LOOK) {
    car.track.sample(car.s + ahead, st);
    const limit = car.physics.cornerSpeed(car, st, car.n);
    if (!(limit < Infinity)) continue;
    // Fastest we may be going now and still be down to `limit` by then.
    allowed = Math.min(allowed, Math.sqrt(limit * limit + 2 * AID_BRAKE * ahead));
  }
  const err = allowed - car.speed;
  if (err < 0) {
    // The same gains the AI uses on its own target speed, so a player being
    // driven keeps pace with one driving properly. An aid that is merely safe
    // is not enough - it has to be quick, or Easy is a guaranteed loss.
    car.throttle = Math.min(car.throttle, Math.max(0, 1 + err * 0.5 * amount));
    car.brake = Math.max(car.brake, Math.min(1, -err * 0.12 * amount));
  }

  // --- hold a lane -------------------------------------------------------
  car.track.sample(car.s, st);
  const lo = car.track.limit(st, -1) + 1.0;
  const hi = car.track.limit(st, 1) - 1.0;
  const want = car.steer;
  if (car.aidLane === undefined) car.aidLane = car.n;
  car.aidLane = clamp(car.aidLane + want * AID_LANE_RATE * dt, lo, hi);

  const wantPsi = clamp(Math.atan2(car.aidLane - car.n, Math.max(12, car.speed)), -0.5, 0.5);
  // Damped on the yaw rate, because under Pro the heading has inertia behind
  // it and a plain proportional term oscillates until it spins.
  const auto = clamp((wantPsi - car.psi) * 1.5 - (car.yawRate || 0) * 1.1, -1, 1);
  car.steer = want * (1 - amount) + auto * amount;
}

export const PHYSICS = { arcade, sport, pro };
export const DEFAULT_PHYSICS = 'arcade';
