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

    // Hand over at the matching point on the other ribbon. The two overlap
    // here, so nothing jumps - see Car.useRoad. The offset is measured
    // *forwards from the entry*, never as a difference of raw `s` values: the
    // pit road crosses the start/finish.
    const dist = this.road.distAt(this.track.delta(this.road.entryS, car.s));
    const pst = this.road.sample(dist, {});
    const want = this.laneFor({ s: dist });
    car.useRoad(this.road, dist, want);
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
   * Put the car back on the circuit at the end of the pit road.
   *
   * `pitDone` is the lap on which it rejoined. A car exits onto the inside
   * lane - which is exactly the place `tryEnter` is watching for - so without
   * it the player came straight back in, ten times in a twelve-lap race.
   * One stop per lap is the rule, and it is the real one too.
   */
  leave(car) {
    const lapS = this.track.wrap(this.road.exitS);
    const st = this.track.sample(lapS, {});
    const inside = this.track.limit(st, -1) + 1.2;
    car.useRoad(this.track, lapS, inside);
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
    // exit does not cross every box downstream of this one.
    car.steer = laneSteer(car, this.laneFor(car), dt, LANE_HOLD);
    const target = this.road.speedLimit;
    car.throttle = THREE.MathUtils.clamp((target - car.speed) * 0.4, 0, 1);
    car.brake = THREE.MathUtils.clamp((car.speed - target) * 0.2, 0, 1);
    if (car.s >= this.road.length - 1) this.leave(car);
    return true;
  }

  /** The pit speed limit, for whoever is holding the rev limiter. */
  get speedLimit() {
    return this.road.speedLimit;
  }
}
