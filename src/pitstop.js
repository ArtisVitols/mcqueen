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
// Queueing in the lane: how far ahead to look, how close two cars count as
// being in the same line, and the gap left to the car in front.
const QUEUE_LOOK = 70;
const QUEUE_WIDE = 2.6;
const QUEUE_GAP = 6.5;
const QUEUE_DECEL = 6.0;
// How near its box a car has to be for "it has stopped" to mean "it has
// arrived". Generous - it only has to beat the queue - see the note in IN.
const BOX_STALL = 12;
// Metres of pit road that must be empty before a car may turn in.
const ENTRY_CLEAR = 9;
// What a car still needs after turning in: the room to cross the lane to its
// box and stop on the mark, from the pit limit.
const BOX_ROOM = 45;

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
    this.firstBox = firstBox;
    // The widest anybody's window can be, for the approach test.
    this.entryWindow = this.windowFor(this.road.boxes.length - 1);
    this.lastBox = this.road.boxes.length
      ? Math.max(...this.road.boxes.map((b) => b.d)) : this.road.length * 0.7;
    this.exitN = this.findExitLane();
    this.crew = null;             // Guido, if the models are loaded
    this.rig = null;              // Mack, parked
  }

  /**
   * How much of the lap this car may still turn in over, in lap metres.
   *
   * **Per car, because it depends on where its box is.** One window for
   * everybody has to be short enough for whoever is stopping first, and a
   * window is a *place*: it admits however many cars can drive through it, and
   * at a safe following distance that was eight of eighteen. The rest went
   * round and tried again, lap after lap - which is exactly what the owner
   * saw, and it is the entry rule that caused it rather than anything in the
   * lane. A car whose box is at the far end of the pits can turn in much
   * later, and letting it do so is what gets the whole field in on one lap.
   *
   * `BOX_ROOM` is what it still needs after turning in: room to cross to its
   * box and stop on the mark.
   */
  windowFor(boxIndex) {
    const box = this.road.boxFor(boxIndex);
    return this.road.lapSpan * Math.max(20, box.d - BOX_ROOM) / this.road.length;
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
    return d >= 0 && d <= this.windowFor(car.gridIndex);
  }

  tryEnter(car, field = null) {
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
    // Turning *in* still moves a car sideways at Yoyleland - about 1.2 m, with
    // ten degrees of roll - because its taper is barely a car wide and its
    // first station sits *outside* the circuit's corridor, so a car cannot
    // project into the middle of it however well it is steered. Refusing until
    // the car fits was tried: Motor Speedway got a 5 m jump elsewhere and
    // Yoyleland admitted nobody at all for a whole race, because `Track.limit`
    // reserves 1.6 m for bodywork and goes *negative* on a lane that narrow.
    // The clamp is the lesser evil, and coming *out* - which is what shows,
    // and what was reported - is 0.18 m on every circuit.
    // Not on top of somebody who is already in. The entry taper is barely
    // wider than a car - a metre and a bit at Motor Speedway - so two cars
    // turning in together have nowhere to be but the same place, and the
    // handover would put one inside the other. Refusing costs a lap; landing
    // on somebody costs the pile-up this whole queue exists to prevent.
    if (field) {
      // A car's length and a bit, and no more.
      //
      // This gate used to demand `car.speed * 1.2` - the room to stop in from
      // *racing* speed - because a car used to arrive at the entrance flat
      // out. It does not any more (`Race.aimForPits` brakes it down to the pit
      // limit first), and that demand was catastrophic: at 70 m/s it wanted
      // eighty metres of empty lane, which a lane with a queue in it never
      // has. Two or three cars got in per lap and the other fifteen drove
      // round and asked again, lap after lap - exactly what the owner saw.
      //
      // What it has to be is the following distance the queue then holds, or
      // a car joins already too close and closes the rest itself.
      for (const other of field) {
        if (other === car || other.road !== this.road) continue;
        const ahead = other.s - hit.s;
        if (ahead > -ENTRY_CLEAR && ahead < ENTRY_CLEAR) return false;
      }
    }
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
  step(car, dt, serviceTime, boxIndex, field = null) {
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
      const target = Math.min(left <= 0 ? 0 : Math.min(this.road.speedLimit, curve),
                              this.queueSpeed(car, field));
      car.throttle = THREE.MathUtils.clamp((target - car.speed) * 0.5, 0, 1);
      // Firmer than the throttle. This brake is doing two jobs - arriving on
      // the mark, and not running into the back of the queue - and the second
      // one has to answer inside a car's length.
      car.brake = THREE.MathUtils.clamp((car.speed - target) * 0.7, 0, 1);

      // Stationary on the mark. The longitudinal test is tight because the
      // approach above can actually hit it; the lateral one is not a condition
      // at all, because at zero speed it cannot be fixed - two conditions
      // where the second is unreachable once the first is true is the
      // definition of a deadlock, and it cost a whole race once.
      // Stopped *here*, not stopped anywhere. The `car.speed < 0.05` half is
      // the anti-deadlock rule - a car that cannot quite creep onto its mark
      // still gets served, because at zero speed it can no longer steer - but
      // it has to stay a rule about arriving. Now that the lane is a queue a
      // car can be brought to a complete halt a long way short of its box, and
      // without this bound it was serviced where it stood: frozen for eight
      // seconds in the middle of the road, with everybody behind it.
      const onMark = Math.abs(left) < BOX_REACH;
      const nearly = Math.abs(left) < BOX_STALL;
      if (car.speed < STOP_SPEED && (onMark || (car.speed < 0.05 && nearly))) {
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
    const target = Math.min(this.road.speedLimit, this.queueSpeed(car, field));
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

  /**
   * How fast this car may go without driving into the one in front.
   *
   * **A pit lane is a queue and nothing in here knew it.** The AI's "do not
   * drive through the back of anybody" lives in `ai.js`, and a car in the lane
   * never reaches it: the state machine takes the controls and returns before
   * the driver runs. So sixteen cars all aimed at the speed limit and drove
   * straight through each other - piled up, sideways, crawling, with the
   * player among them and no button that would help.
   *
   * Braked on the distance remaining, the same curve the stop itself uses, so
   * a car settles a car's length behind the one ahead instead of hitting it.
   * The lateral test is what keeps it a *lane* rule: a car being serviced sits
   * against the wall, several metres off the through-lane, and must not stop
   * the queue driving past it.
   */
  queueSpeed(car, field) {
    if (!field) return Infinity;
    let gap = Infinity;
    for (const other of field) {
      if (other === car || other.road !== car.road) continue;
      // The pit road has ends, so this is a plain subtraction: no wrapping,
      // and anything behind is simply negative.
      const ahead = other.s - car.s;
      if (ahead <= 0 || ahead > QUEUE_LOOK) continue;
      if (Math.abs(other.n - car.n) > QUEUE_WIDE) continue;
      gap = Math.min(gap, ahead);
    }
    if (gap === Infinity) return Infinity;
    // Braked harder than the stop on the mark is. `STOP_DECEL` is tuned to put
    // a car gently on a painted rectangle; this is a car avoiding the one in
    // front, and at the pit limit it needs 40 m rather than 93 to do it. Using
    // the gentle figure meant a car joining the back of a stopped queue simply
    // could not stop in time and drove into it.
    return Math.sqrt(Math.max(0, 2 * QUEUE_DECEL * (gap - QUEUE_GAP)));
  }

  /** The pit speed limit, for whoever is holding the rev limiter. */
  get speedLimit() {
    return this.road.speedLimit;
  }
}
