/**
 * Two people, two devices, one race.
 *
 * The host runs the real `Race` at the usual fixed step and owns the result.
 * The guest sends which buttons are down and renders what it is told. Chosen
 * over lockstep because lockstep stalls *both* players on one late packet, and
 * one of the players is five years old.
 *
 *   guest buttons  --30 Hz-->  host    applied where input.applyTo already is
 *   host snapshots --20 Hz-->  guest   every car's (s, n, psi, speed)
 *
 * A car's whole state is five numbers, so a snapshot of the grid is a couple
 * of hundred bytes and bandwidth is a non-issue. Latency is the problem, and
 * the guest hides it by running the same deterministic `Car.step` on its own
 * car and easing onto the host's answer as it arrives.
 *
 * Everything here talks through a transport with `send`, `onMessage` and
 * `close`, and nothing else. That one seam is what lets the whole stack be
 * tested in-process with faked latency (tools/check_netplay.mjs) rather than
 * only against two real phones.
 */

export const HOST = 'host';
export const GUEST = 'guest';

export const SNAPSHOT_HZ = 20;
export const INPUT_HZ = 30;

/** Message kinds. Kept to one letter each: this goes out 30 times a second. */
export const MSG = {
  HELLO: 'h',        // guest -> host: I am here, and this is the car I want
  START: 's',        // host -> guest: settings and the grid, go
  INPUT: 'i',        // guest -> host: buttons
  SNAP: 'n',         // host -> guest: where everything is
  BYE: 'b',
};

/** Buttons as a bitmask, so an input message is one number. */
export function packButtons(state) {
  return (state.left ? 1 : 0) | (state.right ? 2 : 0) |
         (state.gas ? 4 : 0) | (state.brake ? 8 : 0);
}

export function unpackButtons(bits, out = {}) {
  out.left = !!(bits & 1);
  out.right = !!(bits & 2);
  out.gas = !!(bits & 4);
  out.brake = !!(bits & 8);
  return out;
}

/**
 * The guest's buttons, wearing the same face as `Input`.
 *
 * `Race.fixedStep` calls `applyTo(car, dt, physics)` and does not care where
 * the buttons came from, so a remote player needs nothing else. The steering
 * ramp has to be duplicated rather than shared because `Input` reads the DOM;
 * keeping the two in step is the price of not having a build system.
 */
export class RemoteInput {
  constructor() {
    this.state = { left: false, right: false, gas: false, brake: false };
    this.seen = -1;
  }

  /** @param {number} seq  discards a packet that arrived out of order */
  receive(bits, seq) {
    if (seq !== undefined && seq <= this.seen) return;
    this.seen = seq ?? this.seen;
    unpackButtons(bits, this.state);
  }

  applyTo(car, dt = 0, physics = null) {
    const s = this.state;
    const want = (s.right ? 1 : 0) - (s.left ? 1 : 0);
    const ramp = physics?.steerRamp || 0;
    if (ramp > 0 && dt > 0) {
      const step = ramp * dt * (want === 0 ? 1.8 : 1);
      car.steerCmd += Math.max(-step, Math.min(step, want - car.steerCmd));
    } else {
      car.steerCmd = want;
    }
    if (!physics?.assisted) car.steer = car.steerCmd;
    car.throttle = s.gas ? 1 : 0;
    car.brake = s.brake ? 1 : 0;
  }

  /**
   * Nobody has said anything for a while.
   *
   * Holding the last buttons would leave a disconnected car pinned at full
   * throttle for the rest of the race; releasing them leaves it parked on the
   * racing line. Neither is acceptable, so `Race` hands the car to an AI and
   * this simply stops asking for anything.
   */
  release() {
    for (const k of Object.keys(this.state)) this.state[k] = false;
  }
}

/* --------------------------------------------------------------- snapshots -- */

/**
 * Everything the guest needs to draw a frame.
 *
 * Sent as a flat array rather than objects: it is the same numbers 20 times a
 * second and the shape never varies, so naming each field again in every
 * packet is pure overhead.
 */
export function snapshot(race) {
  const cars = [];
  for (const car of race.field) {
    cars.push(
      round(car.s, 2), round(car.n, 3), round(car.psi, 4),
      round(car.speed, 2), round(car.progress, 1),
      car.lap, car.place, car.finished ? 1 : 0,
      round(car.slip, 2), car.gear | 0,
      // Tyre life and whether the car is in the pits. The second is not
      // cosmetic: a guest that predicts a stopped car through its own physics
      // drives it out from under the crew, exactly as predicting through the
      // countdown drove it most of a lap before the lights went out.
      round(car.tyre, 3), car.onPit ? 1 : 0,
    );
  }
  return { t: MSG.SNAP, c: race.clock, st: race.state, l: race.lights, cars };
}

export const SNAP_STRIDE = 12;

/**
 * Read a snapshot into a set of interpolation targets.
 *
 * The guest does not write these straight onto its cars: the rivals are eased
 * between the last two snapshots, and its own car is *predicted* and only
 * corrected towards this. Snapping every car to the last packet 20 times a
 * second is what network play looks like when it looks bad.
 */
export function readSnapshot(msg, into = []) {
  for (let i = 0; i * SNAP_STRIDE < msg.cars.length; i++) {
    const b = i * SNAP_STRIDE;
    const c = into[i] || (into[i] = {});
    c.s = msg.cars[b];
    c.n = msg.cars[b + 1];
    c.psi = msg.cars[b + 2];
    c.speed = msg.cars[b + 3];
    c.progress = msg.cars[b + 4];
    c.lap = msg.cars[b + 5];
    c.place = msg.cars[b + 6];
    c.finished = !!msg.cars[b + 7];
    c.slip = msg.cars[b + 8];
    c.gear = msg.cars[b + 9];
    c.tyre = msg.cars[b + 10];
    c.onPit = !!msg.cars[b + 11];
  }
  into.length = Math.ceil(msg.cars.length / SNAP_STRIDE);
  return into;
}

function round(v, places) {
  const m = 10 ** places;
  return Math.round(v * m) / m;
}
