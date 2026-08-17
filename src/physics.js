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
/**
 * Worn tyres grip less - and that is all they do.
 *
 * The bar runs 1 to 0 and grip scales from full down to TYRE_FLOOR, which is
 * a lift more in the corners and a slower lap. Deliberately nothing else: no
 * snap, no instability, no surprise. Under Arcade the car still cannot spin,
 * so a five-year-old on worn tyres is slower and never in trouble, which is
 * the rule this project is built on.
 *
 * It is folded into the same multiplier as `car.assist`, so it reaches every
 * handling model through the one function they all share and cannot introduce
 * a discontinuity of its own.
 */
const TYRE_FLOOR = 0.75;

export function tyreGrip(car) {
  const t = car.tyre === undefined ? 1 : car.tyre;
  return car.assist * (TYRE_FLOOR + (1 - TYRE_FLOOR) * t);
}

/**
 * ... and they are slower in a straight line too.
 *
 * Grip alone is not enough, because grip is not what sets the pace here.
 * **Arcade has no tyre forces at all**, so `tyreGrip` reaches nothing under
 * the default model and a dead set cost exactly zero - which makes a stop
 * pure loss and hands the race to whoever skips it. That is not a subtle
 * imbalance: it is the whole strategy inverted, and it is what a real race
 * showed - the player pitted from the lead, a rival that never came in stayed
 * out and won. The same hole exists at Yoyleland under every model, because a
 * superspeedway is flat out and never asks the tyres for a corner.
 *
 * So worn tyres also cost top speed, in `Car.step`'s rev limiter, where every
 * model shares one line and no handling model has to change. A dead set is
 * `TYRE_PACE` of the pace, fading in smoothly with wear - so it is still true
 * that worn tyres only ever make a car *slower*, never harder to drive.
 */
const TYRE_PACE = 0.85;

export function tyreSpeed(car) {
  const t = car.tyre === undefined ? 1 : car.tyre;
  return TYRE_PACE + (1 - TYRE_PACE) * t;
}

/** The most a full tow is worth, as a fraction of the rev limiter. */
const DRAFT_PACE = 0.07;

/**
 * What sitting in somebody's tow is worth in a straight line.
 *
 * **A human needs this on the *limiter*, not on the drag.** The AI has had a
 * tow all along - `ai.js` scales its target speed by the same 7% - and it can
 * use it because it cruises below its rev limiter and has headroom. A person
 * holding the throttle down sits *at* the limiter, so shaving the drag term
 * changes how fast they get there and not where they end up: the car simply
 * runs into the same ceiling and nothing happens. Under Arcade it was worse
 * still, because that model has no drag reduction at all - `car.draft` reached
 * nothing, and Arcade is the default.
 *
 * Applied in `Car.step` beside `tyreSpeed`, through the one line every model
 * shares, so a slipstream works the same whichever one is selected and no
 * handling model has to know about it.
 *
 * Only humans have `car.draft` set - `Race.updateDraft` is called for them and
 * nobody else - so this leaves the AI's own pacing exactly as it was.
 */
export function draftSpeed(car) {
  return 1 + DRAFT_PACE * (car.draft || 0);
}

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
  const bank = car.road.slope(st, n);
  let v = car.topSpeed;
  for (let i = 0; i < 4; i++) {
    v = Math.sqrt(gripLimit(v, bank, tyreGrip(car)) / kappa);
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
// Power, as acceleration x speed. An engine is power-limited once it is
// moving, so its push falls away as 1/v; a flat figure had the car pulling a
// full g at 200 km/h. Under Pro that mattered enormously, because the drive
// force comes straight out of the rear tyres' lateral budget through the
// friction ellipse - it left them 30% of their grip and the car spun out of
// every corner it was asked to take flat.
const S_POWER = 430;
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
  crossRate: 7.5,               // m/s across the track at full lock

  drive(car, st, dt) {
    const v = Math.max(car.speed, 0.001);
    const bank = car.road.slope(st, car.n);
    const grip = gripLimit(v, bank, tyreGrip(car));

    // --- steering ---------------------------------------------------------
    // Braking loads the front and helps it turn in; power unloads it. This is
    // a proxy for weight transfer, not a four-wheel model, and is deliberately
    // small - it should be felt, not fought.
    const transfer = 1 + 0.28 * car.brake - 0.18 * car.throttle;
    const authority = Math.min(1, v / 10) * (0.5 + 0.5 * (1 - Math.min(1, v / 130)));
    car.psi += car.steer * S_STEER_RATE * authority * transfer * dt;
    // Self-centring, faded out as the driver asks for more lock rather than
    // switched on below a threshold. A hard threshold is fine for a car driven
    // by two buttons, but a closed-loop controller settles *exactly* on it and
    // chatters across it - which cost the player 15% of top speed on
    // Yoyleland in a half-metre limit cycle nobody could see.
    const hands = Math.max(0, 1 - Math.abs(car.steer) * 8);
    car.psi -= car.psi * Math.min(1, S_STEER_RETURN * dt) * hands;

    // --- the friction circle ---------------------------------------------
    // Outward-positive centrifugal demand. Rotating the heading outwards at
    // `psiDot` unwinds part of the track's own curvature, which is why a car
    // that turns out of the corner needs less grip, not more.
    //
    // Filtered, because a raw per-step difference is not a rate: a controller
    // trimming the heading by a thousandth of a radian each step reads as
    // 0.6 rad/s, which at racing speed is 40 m/s^2 of imaginary cornering
    // load. That ate the whole friction circle and pinned the car at 65 m/s
    // on a track it should have been flat out on.
    const raw = (car.psi - (car.psiPrev ?? car.psi)) / dt;
    car.psiRate = (car.psiRate ?? 0) + (raw - (car.psiRate ?? 0)) * Math.min(1, dt / 0.12);
    const psiDot = car.psiRate;
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
    const drive = Math.min(car.throttle * S_ENGINE * gearbox(car, dt), S_POWER / v, longMax);
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

/**
 * Pro: a grip-limited car with no aids whatsoever.
 *
 * Rewritten. The first version was a slip-angle bicycle model - front and rear
 * cornering stiffnesses, a friction ellipse, self-aligning torque - and it was
 * chaotic to drive. The reason is structural, not a matter of tuning: slip
 * angle depends on lateral velocity, lateral velocity is driven by tyre force,
 * and tyre force depends on slip angle. That is a second-order feedback loop
 * with very little damping, so any input rings, and at racing speed the ringing
 * saturates an axle and the car is gone. It is also singular at a standstill.
 *
 * This one is built the other way round, and every quantity in it is bounded:
 *
 *   1. The rack is fixed-ratio and commands a **yaw rate**, kinematically -
 *      `v * tan(delta) / wheelbase`. No feedback, no resonance, and zero at a
 *      standstill because a stationary car does not rotate.
 *   2. That yaw demands a lateral acceleration. The tyres supply what they
 *      have and no more, so asking for too much simply turns the car less:
 *      it **understeers and runs wide**, which is a thing you can feel and
 *      back off from rather than a thing that spits you round.
 *   3. Whatever the tyres could not supply becomes a **slide** - real lateral
 *      velocity, which costs speed and has to be driven out.
 *   4. Power beyond the rear tyres' share of the grip **rotates the car
 *      further into the corner**. Get greedy mid-bend and the tail steps; lift
 *      and it comes back. That is the oversteer, and it is proportional to how
 *      greedy you were rather than to how long the loop has been ringing.
 *
 * Still no assists: no corner braking, no lane holding, no automatic overtake,
 * no traction control, and no speed-sensitive rack quietly refusing to ask the
 * tyres for more than they have. What changed is that the car is *predictable*
 * when you overdrive it, not that it stopped being possible to overdrive.
 *
 * Written in track yaw, like everything else here - see CLAUDE.md. In world
 * yaw a car with no steering input carries straight on while the road turns
 * away, and nothing ever brings it back.
 */
// Radians of front wheel angle at full lock.
//
// Sized for the *controls*, which are two buttons rather than a wheel. At
// 70 m/s the tyres can sustain about 0.64 rad/s of yaw, which is a wheel
// angle of a degree and a half - so a lock a driver could hold all day in a
// real car is, through a button, an instant trip into the scenery. The ramp
// below is what meters it: a dab gives a small angle, and holding it down at
// speed washes the car wide, which is the model doing its job.
const PRO_LOCK = 0.30;
const PRO_WHEELBASE = 2.7;            // m
const PRO_YAW_LAG = 8.0;              // 1/s the car's yaw follows the command
const PRO_V_FLOOR = 6;                // m/s; below this grip cannot be exceeded
const PRO_REAR_SHARE = 0.54;          // the rear's share of the grip budget
const PRO_OVERSTEER = 1.3;            // how hard surplus power rotates the car
const PRO_SLIDE_SCRUB = 0.05;         // per second, how fast a slide washes off
const PRO_SCRUB = 0.8;               // speed lost per unit of grip asked for and missed
const PRO_CORNER = 1.0;              // how far past the no-slide limit is still quick
// Rad/s of turn asked for at full lock. The buttons command a *rate*, and the
// rack follows from it - see the note in drive(). This is the steering ratio,
// which with two buttons instead of a wheel the game has to choose.
const PRO_YAW_CMD = 0.95;
const PRO_RECOVER_PSI = 1.15;         // ~66 deg, where the safety net starts
const PRO_SCRUB_FLOOR = 10;           // m/s below which a spin stops costing speed

const pro = {
  id: 'pro',
  label: 'Pro',
  blurb: 'No assists at all. Overdrive it and it washes wide.',
  maxPsi: 1.5,
  // How fast the driver can wind the wheel over. Not an assist: a real rack
  // takes about a quarter second to full lock, and buttons that snap from
  // centre to full in one frame are not a steering wheel.
  steerRamp: 4.5,
  wallScrub: 0.18,
  assisted: false,
  geared: true,
  yawModel: true,               // psi is a state here, not a command
  // The AI drives this too, and it is a driver rather than an aid. With a
  // bounded, first-order yaw these can be firmer than the old model allowed.
  // Gentle, because the rack is not. A yaw command is `v*tan(delta)/L`, so at
  // racing speed a hair of lock is already the whole grip budget - a
  // controller tuned like Sport's saws at the wheel, misses grip on every
  // correction, and scrubs a second a lap away for nothing.
  steerGain: 3.2,
  yawDamp: 1.2,
  laneClose: 0.5,

  drive(car, st, dt) {
    const v = Math.max(car.speed, 0.001);
    const bank = car.road.slope(st, car.n);
    const grip = gripLimit(v, bank, tyreGrip(car));

    // Longitudinal first, because what it uses is not available to turn with.
    const wantDrive = Math.min(car.throttle * S_ENGINE * gearbox(car, dt), S_POWER / v);
    const wantStop = car.brake * S_BRAKE;
    const longUsed = wantDrive + wantStop;
    const latMax = Math.sqrt(Math.max(0, grip * grip - longUsed * longUsed));

    // The buttons command a **rate of turn**, and the rack follows from it.
    //
    // This is the steering *ratio*, not an aid. A driver with a wheel turns it
    // less at speed without thinking about it; with two buttons the game has
    // to make that choice, and a fixed lock makes the control unusable - 0.30
    // rad at 60 m/s asks for 4 rad/s of yaw when the tyres can hold 0.6, so a
    // single tap wiped the car's speed out and the AI could not steer without
    // scrubbing a second a lap away.
    //
    // Nothing here limits the car to what the tyres have: at racing speed full
    // lock still asks for more grip than exists, still understeers, and still
    // lets the tail go. What it buys is that the first few degrees mean
    // something, which is what makes it driveable rather than a trap.
    const yawWant = car.steer * PRO_YAW_CMD;
    // ... and the front wheels sit wherever that rate puts them, for the
    // visuals and for anything else reading `steerAngle`.
    const delta = clamp(Math.atan(yawWant * PRO_WHEELBASE / Math.max(v, 3)),
                        -PRO_LOCK, PRO_LOCK);
    car.steerAngle = delta;

    // The lateral acceleration that would take, outward-positive. Following
    // the road at all is worth `-v*v*kappa` of it: in track space holding a
    // line is otherwise free, and a corner has to cost something.
    const need = v * yawWant - v * v * st.kappa;
    const have = clamp(need, -latMax, latMax);

    // Understeer falls straight out of that clamp: the yaw the car actually
    // gets is whatever the tyres could pay for.
    let yawTarget = have / Math.max(v, PRO_V_FLOOR) + v * st.kappa;

    // Power oversteer. Anything the engine asks for beyond the rear's share
    // of the grip rotates the car further the way it is already going. No
    // traction control: this is the whole point of the model.
    const spare = grip * PRO_REAR_SHARE - wantDrive;
    if (spare < 0) {
      const way = Math.sign(yawTarget) || Math.sign(yawWant) || Math.sign(car.psi) || 1;
      yawTarget += way * (-spare) * PRO_OVERSTEER / Math.max(v, 12);
    }

    // The car has mass, so yaw follows its command rather than snapping to it.
    car.yawRate = ((car.yawRate || 0)
                   + (yawTarget - (car.yawRate || 0)) * Math.min(1, dt * PRO_YAW_LAG));
    car.psi += car.yawRate * dt;

    // Understeer is already in `psi` and must not be added to `vy` as well.
    //
    // The yaw above follows what the tyres could actually pay for, so a car
    // asked for more than they have simply does not rotate enough and its
    // heading drifts outward - which *is* running wide, and `Car.step` turns
    // it into lateral movement through sin(psi). Adding the shortfall to `vy`
    // on top double-counts it, and with the opposite sign: the missing force
    // is an *inward* one, so it pushed a car that could not make the corner
    // towards the infield.
    car.vy *= Math.pow(PRO_SLIDE_SCRUB, dt);

    // The safety net. Not decoration: without it a spun car sits there and the
    // race never finishes - and the AI drives this model too.
    if (Math.abs(car.psi) > PRO_RECOVER_PSI) {
      const over = Math.abs(car.psi) - PRO_RECOVER_PSI;
      car.psi -= Math.sign(car.psi) * Math.min(Math.abs(car.psi), (over * 3.5 + 0.9) * dt);
      car.yawRate *= Math.pow(0.02, dt);
      car.vy *= Math.pow(0.05, dt);
      if (car.speed > PRO_SCRUB_FLOOR) car.speed *= Math.pow(0.25, dt);
    }

    // How much lateral grip was asked for and not found. This is the whole
    // cost of overdriving: it scrubs speed, it squeals, and it is what makes
    // braking properly faster than not.
    const miss = Math.abs(need - have);
    car.slip = Math.min(1, miss / 10 + Math.abs(car.vy) / 4);

    const longMax = Math.sqrt(Math.max(0, grip * grip - have * have));
    const drive = Math.min(wantDrive, longMax);
    const stop = Math.min(wantStop, longMax);
    const drag = S_DRAG * v * v * (1 - 0.22 * (car.draft || 0)) + S_ROLL_DRAG;
    // A tyre that is not gripping is scrubbing, and that costs speed. Without
    // it a throttle-pinned car simply understeers round every corner for free
    // and beats a driver who brakes for them, which is the wrong way round.
    //
    // Squared, and relative to the grip available, so the shape is right: a
    // *little* understeer is quick - which is why the AI is allowed to run
    // just past the no-slide limit - and arriving far too fast is ruinous.
    // Charging it linearly made both true at once, so barrelling in cost
    // about what braking did and there was no reason to brake.
    const slideDrag = PRO_SCRUB * miss * miss / Math.max(4, grip);

    car.speed = Math.max(0, car.speed + (drive - stop - drag - slideDrag) * dt);
  },

  cornerSpeed(car, st, n) {
    // A margin *above* the no-slide limit, unlike every other model here.
    //
    // `cornerSpeedAt` is the speed at which the tyres exactly balance the
    // corner with nothing to spare. This model lets a car carry more than that
    // and pay for it in scrub - which is real, and quick: a little understeer
    // is faster than lifting to the point where there is none. An AI held to
    // the pure limit was ten metres a second slower through every bend than a
    // car simply left at full throttle, which is the wrong way round and made
    // the whole model look broken.
    return cornerSpeedAt(car, st, n) * PRO_CORNER;
  },
};

/* ------------------------------------------------------- lane following -- */

const LANE_CLOSE = 0.85;              // 1/s a lane error is closed at
const LANE_RATE_MAX = 5.0;            // m/s of sideways movement the AI will ask for
const STEER_GAIN = 16.0;              // steer per radian of heading error
const YAW_DAMP = 1.1;                 // ... per rad/s of yaw rate, where there is one
const STEER_SLEW = 6.0;               // how fast the commanded lock may change, 1/s

/**
 * Steering input that makes the car cross the track at `rate` metres a second.
 *
 * Everything that steers a car here goes through this, because the gain is the
 * part that is easy to get wrong: at 70 m/s, crossing at 4 m/s is only 0.06 rad
 * of heading, so a gain of 1.5 asks for 9% of full lock and the car appears not
 * to steer at all. That is exactly what Sport and Pro did on every difficulty
 * except Hard.
 */
function rateSteer(car, rate, dt = 0) {
  const p = car.physics;
  const v = Math.max(8, car.speed);
  // The car crosses the track at v*sin(psi) *plus* whatever it is sliding, and
  // at the limit that slide is metres a second. A controller that ignores it
  // holds a fine line all through a corner and then slams to full lock the
  // moment the corner ends and the slide has nothing left to balance it.
  const need = rate - (car.vy || 0);
  const wantPsi = clamp(Math.asin(clamp(need / v, -0.6, 0.6)), -p.maxPsi, p.maxPsi);
  const damp = p.yawModel ? (car.yawRate || 0) * (p.yawDamp ?? YAW_DAMP) : 0;
  const want = clamp((wantPsi - car.psi) * (p.steerGain ?? STEER_GAIN) - damp, -1, 1);
  // Slew-limit the lock where the heading has inertia behind it. A controller
  // that can slam from full left to full right in one 8 ms step will always
  // find a way to resonate with the yaw, and what that looks like on screen is
  // a car steering chaotically for no reason the driver can see.
  if (!p.yawModel || !(dt > 0)) return want;
  const step = STEER_SLEW * dt;
  return clamp(car.steer + clamp(want - car.steer, -step, step), -1, 1);
}

/**
 * Steering input that takes a car to lane `target` and keeps it there.
 *
 * A proportional term on lateral error alone is an undamped second-order
 * system: the heading lags the command, so the car overshoots, comes back and
 * hunts. That is what had the whole field weaving across Palm Mile's straights
 * in waves with a one to five second period. Turning the error into a
 * *bounded closing rate* makes a big lane change a steady sweep rather than a
 * lunge, and the damping in rateSteer is on the yaw rate, which is the state
 * that actually carries the overshoot.
 */
export function laneSteer(car, target, dt = 0, close = null) {
  const k = close ?? car.physics.laneClose ?? LANE_CLOSE;
  return rateSteer(car, clamp((target - car.n) * k, -LANE_RATE_MAX, LANE_RATE_MAX), dt);
}

/**
 * Closing rate for a move the driver has committed to, as opposed to simply
 * holding a lane. Easing across at the lane-holding rate takes three seconds
 * under the Pro model, which is longer than an overtake or a defensive move
 * lasts - so the move was abandoned half-finished every time.
 */
export const COMMITTED_CLOSE = 2.2;

/* ----------------------------------------------------------- driver aid -- */

const AID_BRAKE = 22.0;               // m/s^2 the aid plans its braking at
const AID_LOOK = [0, 22, 48, 78, 112];
const AID_CROSS_RATE = 7.5;           // m/s across the track at full lock, by default
const AID_EDGE = 1.0;                 // stop steering this far from the edge
const AID_TRAFFIC = 40;               // metres ahead the aid looks for traffic
// Close enough to be touching, and then some. Inside this the car in front is
// blocking whether or not it is being caught.
const AID_TOUCHING = 6.5;
const AID_PASS = 3.2;                 // ... and how far beside it to aim
const AID_PASS_CLOSE = 2.2;           // 1/s; brisker than simply holding a lane

/**
 * Lifts, brakes and steers for the player.
 *
 * "Easy must be winnable by holding the throttle down and nothing else" is a
 * rule of this project, and a five-year-old can tap any entry in the physics
 * menu. Neither grip model can honour that on its own:
 *
 *  - Sport arrives at a 63 m corner doing 280, slides to the wall and scrubs
 *    there for half the turn.
 *  - Pro is worse. With tyre forces driving the heading, a car with no
 *    steering input cannot generate the inward force a corner needs at all -
 *    it simply understeers off. Holding the throttle is not a slow way round;
 *    it is not a way round.
 *
 * So the aid drives the corner speed. What it must *not* do is drive the
 * steering: holding a lane the buttons only nudged made the car feel like it
 * had no steering at all on anything but Hard, which is precisely how it was
 * reported. Pressing left here means "go left", at a rate the driver can feel,
 * exactly as the arcade model behaves; letting go means "hold this lane".
 *
 * @param {number} amount 0..1, how much of the speed aid to apply
 */
export function driverAid(car, amount, dt, field = null) {
  if (!car.physics.assisted) return;
  const st = car._aidSt || (car._aidSt = {});
  amount = Math.min(1, amount * (car.physics.aidScale ?? 1));

  if (amount > 0) {
    let allowed = Infinity;
    for (const ahead of AID_LOOK) {
      car.road.sample(car.s + ahead, st);
      const limit = car.physics.cornerSpeed(car, st, car.n);
      if (!(limit < Infinity)) continue;
      // Fastest we may be going now and still be down to `limit` by then.
      allowed = Math.min(allowed, Math.sqrt(limit * limit + 2 * AID_BRAKE * ahead));
    }
    const err = allowed - car.speed;
    if (err < 0) {
      // The same gains the AI uses on its own target speed, so a player being
      // driven keeps pace with one driving properly. An aid that is merely
      // safe is not enough - it has to be quick, or Easy is a guaranteed loss.
      car.throttle = Math.min(car.throttle, Math.max(0, 1 + err * 0.5 * amount));
      car.brake = Math.max(car.brake, Math.min(1, -err * 0.12 * amount));
    }
  }

  const want = car.steerCmd;
  car.road.sample(car.s, st);
  const lo = car.road.limit(st, -1);
  const hi = car.road.limit(st, 1);

  if (Math.abs(want) > 0.02) {
    // Steering. Give the driver a crossing rate, and stop feeding it in once
    // they have run out of road on that side.
    let rate = want * (car.physics.crossRate ?? AID_CROSS_RATE);
    if (rate > 0) rate *= clamp((hi - AID_EDGE - car.n) / 1.5, 0, 1);
    else rate *= clamp((car.n - lo - AID_EDGE) / 1.5, 0, 1);
    car.aidLane = car.n;              // wherever they leave it becomes the lane
    car.steer = rateSteer(car, rate, dt);
  } else {
    if (car.aidLane === undefined) car.aidLane = car.n;
    // Pull out for traffic. Holding the throttle down has to be enough to win
    // on Easy, and it is not if the car spends the race nose to tail behind
    // someone slower - the field on a superspeedway runs in a queue, and a
    // player who never touches the buttons simply joins the back of it.
    const block = field && amount > 0 ? blockedBy(car, field) : null;
    if (block) {
      // Aim beside them, on whichever side there is more room, and get there
      // at a pace that actually completes the pass: easing across at the
      // lane-holding rate takes three seconds, by which time the corner has
      // arrived and the move is abandoned.
      const inside = clamp(block.n - AID_PASS, lo + AID_EDGE, hi - AID_EDGE);
      const outside = clamp(block.n + AID_PASS, lo + AID_EDGE, hi - AID_EDGE);
      const pick = Math.abs(inside - block.n) > Math.abs(outside - block.n) ? inside : outside;
      car.aidLane = pick;
    }
    car.aidLane = clamp(car.aidLane, Math.min(lo, hi) + AID_EDGE, Math.max(lo, hi) - AID_EDGE);
    const close = block ? AID_PASS_CLOSE : (car.physics.laneClose ?? 0.85);
    const cross = car.physics.crossRate ?? AID_CROSS_RATE;
    car.steer = rateSteer(car, clamp((car.aidLane - car.n) * close, -cross, cross), dt);
  }
}

/** The car directly ahead and in the way, if this car is catching it. */
function blockedBy(car, field) {
  let best = null;
  let gap = AID_TRAFFIC;
  for (const other of field) {
    if (other === car || other.finished) continue;
    const d = car.track.delta(car.s, other.s);
    if (d <= 2 || d >= gap) continue;
    if (Math.abs(other.n - car.n) > 2.6) continue;
    // "Am I catching it?" - but a car you are already nose to tail with is
    // blocking you whatever the speedometer says. Contact clamps the car
    // behind to the speed of the one in front, so the moment you arrive the
    // closing rate is zero and this test says "not blocked" - which had the
    // aid give up on the pass at exactly the point the pass became the only
    // way past. Before cars were solid you simply went through, and the
    // question never came up.
    if (d > AID_TOUCHING && other.speed > car.speed - 0.5) continue;
    gap = d;
    best = other;
  }
  return best;
}

export const PHYSICS = { arcade, sport, pro };
export const DEFAULT_PHYSICS = 'arcade';
