import * as THREE from 'three';
import { PitRoad, ENTRY_REACH } from './pits.js';
import { laneSteer } from './physics.js';

/**
 * Pit stops: driving in, stopping on the box, being serviced, driving out.
 *
 * The geometry is `src/pits.js`; this is the part with a state machine in it.
 * Kept out of `Car` on purpose - a car knows how to drive on a ribbon and
 * nothing else, which is what stops a pit stop from ever becoming a
 * lap-counting or corridor bug.
 *
 *   OUT      on the circuit
 *   IN       committed, on the pit road, heading for the box
 *   STOPPED  in the box, stationary, waiting for the crew
 *   SERVICE  Guido is going round the wheels
 *   LEAVING  back down the lane, still on the pit road
 *
 * Guido is only ever sent to the *local* player's car: it is a thing to watch,
 * and seven forklifts working at once is a car park, not a pit stop.
 */

export const Pit = {
  OUT: 'out', IN: 'in', STOPPED: 'stopped', SERVICE: 'service', LEAVING: 'leaving',
};

const STOP_SPEED = 0.35;        // m/s that counts as stopped in the box
const BOX_REACH = 1.2;          // metres either side of the box centre
const STOP_DECEL = 2.6;         // m/s^2 aimed at the mark - a firm, smooth stop
const SETTLE = 0.35;            // seconds held still before the crew start
const LANE_HOLD = 1.4;          // how hard a car in the pits holds its lane
// Metres before the box at which the car peels out of the through-lane. Long
// enough to cross the lane while still rolling - steering needs speed - and
// short enough that it is not driving over anybody else's box to get there.
const PEEL = 26;
// How far either side of the nominal exit to look for the place the pit road
// and the racing line overlap. Generous: it is a one-off search at a handover,
// and the taper is most of a hundred metres long.
const REJOIN_REACH = 140;
// How far outside the corridor a forced rejoin will still take the projection
// rather than falling back to a fixed lane.
const REJOIN_SLACK = 3;
// How hard the run to the exit holds the middle of the lane. Firmer than
// LANE_HOLD: see the note in the LEAVING branch.
const EXIT_HOLD = 2.4;
// How far inside the circuit's corridor the exit lane aims. Small: it only
// has to clear the edge, and every metre of it is a metre the car is not
// using of the pit road.
const EXIT_MARGIN = 1.2;

/** How long the crew take, per difficulty. Easy is fastest - see below. */
export const SERVICE_TIME = { easy: 3.0, normal: 5.5, hard: 8.0 };

export class PitLane {
  /**
   * @param {import('./track.js').Track} track  the circuit
   * @param {object} data                       the `pit` block from track data
   */
  constructor(track, data) {
    this.track = track;
    this.road = new PitRoad(data);
    // Measure the ribbon against the circuit once, so a car in the pits is
    // ranked by where it actually is rather than by how far down the lane it
    // has got. See PitRoad.lapAt.
    this.road.mapOnto(track);
    // How much of the lap the pit entrance covers.
    //
    // Half the run to the first box, expressed in lap metres. A pit entry is
    // a place, not a stretch: allowing the first half of the whole lane let a
    // car turn in *level with its own box* at racing speed, with nowhere left
    // to brake. This leaves the same half of the lane to slow down in on
    // every circuit, whatever the geometry.
    const firstBox = this.road.boxes.length
      ? Math.min(...this.road.boxes.map((b) => b.d)) : this.road.length * 0.3;
    this.entryWindow = this.road.lapSpan * (firstBox * 0.5) / this.road.length;
    this.lastBox = this.road.boxes.length
      ? Math.max(...this.road.boxes.map((b) => b.d)) : this.road.length * 0.7;
    this.exitN = this.findExitLane();
    this.crew = null;             // Guido, if the models are loaded
    this.rig = null;              // Mack, parked
  }

  /** True while `s` is inside the stretch of lap the pit road parallels. */
  inWindow(s) {
    const d = this.track.delta(this.road.entryS, s);
    return d >= 0 && d <= this.road.lapSpan;
  }

  /**
   * Ask to pit. Only takes effect once the car is in the entry taper *and*
   * has actually moved down to the inside - you have to aim for it, or a car
   * running a low line would be dragged in every lap.
   */
  /** Is the car in the stretch of lap where it could turn in at all? */
  canEnter(car) {
    if (car.pit !== Pit.OUT || car.finished || car.onPit) return false;
    if (car.pitDone === car.lap) return false;      // already been in this lap
    const d = this.track.delta(this.road.entryS, car.s);
    return d >= 0 && d <= this.entryWindow;
  }

  tryEnter(car) {
    if (!this.canEnter(car)) return false;
    const st = this.track.sample(car.s, {});
    const inside = this.track.limit(st, -1);
    if (car.n > inside + ENTRY_REACH) return false;

    // Hand over at the car's *own place* on the other ribbon, not at the
    // proportionally equivalent distance down it.
    //
    // The two are not the same thing: the pit road is a chord and the lap is
    // an arc, so inside the taper the same fraction of each is tens of metres
    // apart on the ground. Handing over by proportion put a rival 46 m from
    // where it had been, in one frame, at Yoyleland. `project` asks where the
    // car actually is. The offset hint is measured *forwards from the entry*,
    // never as a difference of raw `s` values: the pit road crosses the
    // start/finish.
    const hint = this.road.distAt(this.track.delta(this.road.entryS, car.s));
    const hit = this.road.project(car.position.x, car.position.z, hint);
    if (!hit) return false;
    // Only where the ribbons really do overlap. Off the end of that, the
    // handover would be a jump however it was computed, so refuse and let the
    // car come round again.
    const pst = this.road.sample(hit.s, {});
    if (hit.n < this.road.limit(pst, -1) - ENTRY_REACH ||
        hit.n > this.road.limit(pst, 1) + ENTRY_REACH) return false;
    const n = THREE.MathUtils.clamp(hit.n, this.road.limit(pst, -1), this.road.limit(pst, 1));
    car.useRoad(this.road, hit.s, n);
    car.pit = Pit.IN;
    car.pitTimer = 0;
    return true;
  }

  /**
   * The through-lane: the outer side of the pit road, away from the boxes.
   *
   * Everything that is not stopping uses it - coming in, going out, and
   * driving past a car being serviced. The boxes sit against the wall on the
   * inboard side, so this is the side that stays clear.
   */
  laneFor(car) {
    const st = this.road.sample(car.s, {});
    const hi = this.road.limit(st, 1);
    const lo = this.road.limit(st, -1);
    // Half a car's width inside the outer edge, and never past the middle -
    // on a narrow stretch the whole lane may be barely wider than one car.
    return Math.max((lo + hi) / 2, hi - 1.3);
  }

  /** A legal lateral offset on the pit ribbon: the middle of its corridor. */
  nearestLane(pst) {
    const lo = this.road.limit(pst, -1);
    const hi = this.road.limit(pst, 1);
    return (lo + hi) / 2;
  }

  /**
   * Which lane of the pit road to leave along, so that leaving is *driving*.
   *
   * Measured once, because it is a property of the two roads and not of any
   * car. The ribbon does not end on the racing line, it ends near it: at Motor
   * Speedway its last station projects 0.8 m *outside* the circuit's corridor
   * - still on asphalt, but inside the margin `Track.limit` reserves for
   * bodywork. A car sitting neatly on the ribbon's centreline therefore has
   * nowhere legal to be handed over to, and gets put on the road instead of
   * driving onto it: a 0.8 m sideways jump at the exit, every time, which is
   * exactly what it looks like.
   *
   * So aim at the offset whose *projection* is comfortably inside the road.
   * Then the handover is 4 cm - one step of travel - and there is nothing to
   * see.
   */
  findExitLane() {
    const st = this.road.sample(this.road.length, {});
    const p = this.road.position(st, 0, new THREE.Vector3());
    const hit = this.track.project(p.x, p.z, this.track.wrap(this.road.exitS), REJOIN_REACH);
    if (!hit) return 0;
    const tst = this.track.sample(hit.s, {});
    const want = THREE.MathUtils.clamp(hit.n,
      this.track.limit(tst, -1) + EXIT_MARGIN, this.track.limit(tst, 1) - EXIT_MARGIN);
    // The two roads run near enough parallel where they meet, so a metre
    // across one is a metre across the other. Kept inside the pit road's own
    // corridor, which is the one the car actually has to drive down.
    const pst = this.road.sample(this.road.length, {});
    return THREE.MathUtils.clamp(want - hit.n,
      this.road.limit(pst, -1), this.road.limit(pst, 1));
  }

  /**
   * Where this car would rejoin the circuit, or null if it cannot yet.
   *
   * The exit taper runs back onto the racing line, so towards its end the two
   * ribbons overlap and a car can simply be handed across at the place it
   * already occupies. Before that it is still out on the infield. Asking the
   * geometry rather than assuming "the end of the ribbon is the merge" also
   * covers Yoyleland, where the circuit's own corridor pinches at the last
   * station and the ribbon ends four metres outside it.
   */
  rejoinAt(car, slack = 0) {
    const hit = this.track.project(car.position.x, car.position.z,
      this.track.wrap(this.road.exitS), REJOIN_REACH);
    if (!hit) return null;
    const st = this.track.sample(hit.s, {});
    if (hit.n < this.track.limit(st, -1) - slack
        || hit.n > this.track.limit(st, 1) + slack) return null;
    return hit;
  }

  /**
   * Put the car back on the circuit.
   *
   * `pitDone` is the lap on which it rejoined. A car exits onto the inside
   * lane - which is exactly the place `tryEnter` is watching for - so without
   * it the player came straight back in, ten times in a twelve-lap race.
   * One stop per lap is the rule, and it is the real one too.
   */
  leave(car, at = null) {
    // Off the end of the ribbon there is no more road to drive, so take the
    // projection even if it is a little outside the corridor and clamp: being
    // half a metre out of place beats being put back somewhere else entirely.
    const hit = at || this.rejoinAt(car) || this.rejoinAt(car, REJOIN_SLACK);
    const lapS = hit ? hit.s : this.track.wrap(this.road.exitS);
    const st = this.track.sample(lapS, {});
    const n = hit === null ? this.track.limit(st, -1) + 1.2
      : THREE.MathUtils.clamp(hit.n, this.track.limit(st, -1), this.track.limit(st, 1));
    car.useRoad(this.track, lapS, n);
    // Progress is *mapped* through a stop rather than accumulated, so by the
    // time a car comes back it can be a metre or two out. Re-anchor it to
    // where the car has actually ended up: the running order is the one thing
    // a pit stop must never quietly change, and a place decided by a metre
    // nobody drove is exactly the finish that looks broken from the cockpit.
    car.progress += this.track.delta(this.track.wrap(car.progress), lapS);
    car.pit = Pit.OUT;
    car.pitTimer = 0;
    car.pitDone = car.lap;
  }

  /**
   * One step of a car's stop. Returns true if it took over the controls.
   *
   * While stopped the car is *frozen*, not merely slow: the throttle is cut,
   * the brakes are on and the speed is zeroed. A car creeping out from under
   * the crew is the one thing that would make the whole thing look broken.
   */
  step(car, dt, serviceTime, boxIndex) {
    if (car.pit === Pit.OUT) return false;

    const box = this.road.boxFor(boxIndex);
    car.pitTimer = (car.pitTimer || 0) + dt;

    if (car.pit === Pit.IN) {
      // Down the *lane*, not down the row of boxes.
      //
      // The boxes are against the wall, so aiming at one from the entry drives
      // the whole length of the pits over every other car's box - which is
      // where a rival being serviced is parked. Run the outer half of the lane
      // instead and peel in only for the last few car lengths, which is what a
      // pit lane is for and what everybody else is expecting.
      //
      // The turn-in still has to start early enough to be *possible*:
      // `laneSteer` asks for a crossing rate, so a car that brakes to walking
      // pace before moving over can never move over at all - it cannot steer
      // at zero speed. `PEEL` is measured to leave room for both.
      const lane = this.laneFor(car);
      const peeling = car.s > box.d - PEEL;
      car.steer = laneSteer(car, peeling ? box.n : lane, dt, LANE_HOLD);

      // Brake on the distance *remaining*, so the car arrives at rest on the
      // mark rather than stopping wherever it happens to be slow enough. A
      // flat "close enough, then brake" left it up to 3.5 m short of its own
      // box, which is a car-length off a painted rectangle you can see.
      const left = box.d - car.s;
      const curve = Math.sqrt(Math.max(0, 2 * STOP_DECEL * left));
      const target = left <= 0 ? 0 : Math.min(this.road.speedLimit, curve);
      car.throttle = THREE.MathUtils.clamp((target - car.speed) * 0.5, 0, 1);
      car.brake = THREE.MathUtils.clamp((car.speed - target) * 0.35, 0, 1);

      // Stationary on the mark. The longitudinal test is tight because the
      // approach above can actually hit it; the lateral one is not a condition
      // at all, because at zero speed it cannot be fixed - two conditions
      // where the second is unreachable once the first is true is the
      // definition of a deadlock, and it cost a whole race once.
      const onMark = Math.abs(left) < BOX_REACH;
      if (car.speed < STOP_SPEED && (onMark || car.speed < 0.05)) {
        car.pit = Pit.STOPPED;
        car.pitTimer = 0;
      }
      // Missed it: the lane runs out, so leave and try again next lap.
      if (car.s >= this.road.length - 1) this.leave(car);
      return true;
    }

    if (car.pit === Pit.STOPPED) {
      car.throttle = 0;
      car.brake = 1;
      car.speed = 0;
      car.vy = 0;
      if (car.pitTimer >= SETTLE) { car.pit = Pit.SERVICE; car.pitTimer = 0; }
      return true;
    }

    if (car.pit === Pit.SERVICE) {
      car.throttle = 0;
      car.brake = 1;
      car.speed = 0;
      car.vy = 0;
      if (car.pitTimer >= serviceTime) {
        car.tyre = 1;
        car.pit = Pit.LEAVING;
        car.pitTimer = 0;
      }
      return true;
    }

    // LEAVING: back out into the through-lane and away, so the run to the
    // exit does not cross every box downstream of this one - and then, once
    // the boxes are behind it, onto the **middle of the pit road**.
    //
    // That last part is what makes the handover clean. The ribbon merges into
    // the racing line along its own centreline, and only just: at Motor
    // Speedway its last station sits 0.3 m inside the circuit's corridor. A
    // car still out in the through-lane at that point projects *outside* the
    // road, so `rejoinAt` refuses all the way to the end of the ribbon and the
    // car is put back on the racing line rather than driven there - a two
    // metre sideways jump, on a third of all exits. Aiming at the centreline
    // costs nothing (there are no boxes left to cross) and turns those exits
    // into the 4 cm ones.
    // Held firmly, because whatever lateral error is left when the ribbon runs
    // out is exactly the jump: the handover can only take the car's own place
    // on the road, and off the end of the ribbon there is no more road.
    const out = car.s > this.lastBox + BOX_REACH;
    car.steer = laneSteer(car, out ? this.exitN : this.laneFor(car), dt,
                          out ? EXIT_HOLD : LANE_HOLD);
    const target = this.road.speedLimit;
    car.throttle = THREE.MathUtils.clamp((target - car.speed) * 0.4, 0, 1);
    car.brake = THREE.MathUtils.clamp((car.speed - target) * 0.2, 0, 1);
    // Rejoin the moment the taper has actually merged, rather than at the last
    // station regardless. Gated past the boxes so a car cannot be handed back
    // somewhere the two ribbons happen to pass close on the way in.
    const at = car.s > this.lastBox + 20 ? this.rejoinAt(car) : null;
    if (at) this.leave(car, at);
    else if (car.s >= this.road.length - 1) this.leave(car);
    return true;
  }

  /** The pit speed limit, for whoever is holding the rev limiter. */
  get speedLimit() {
    return this.road.speedLimit;
  }
}
