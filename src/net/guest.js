import * as THREE from 'three';
import { readSnapshot } from '../net.js';
import { State } from '../race.js';

/**
 * The guest's view of a race running on somebody else's phone.
 *
 * Two different jobs, and getting them the same way is what makes network
 * play feel bad:
 *
 *  - **Rivals** are eased between the last two snapshots. They are 20 Hz data
 *    being drawn at 60, so the only question is how to fill the gaps.
 *  - **Your own car** is *predicted*: the same deterministic `Car.step` runs
 *    locally against your own buttons, so pressing a button does something
 *    this frame rather than in a round trip's time. Each snapshot then pulls
 *    the prediction towards the host's answer over a fraction of a second.
 *
 * Snapping every car onto the newest packet would be simpler and is what a
 * first attempt usually does. It also makes a 60 Hz screen show 20 Hz motion
 * and puts your own car a round trip behind your thumbs.
 */

const BLEND = 0.18;          // seconds to fold a correction in over
const HARD_RESET = 25;       // metres of disagreement that means "just jump"

export class GuestView {
  constructor(race) {
    this.race = race;
    this.prev = null;         // the snapshot before last
    this.next = null;         // ... and the newest
    this.prevAt = 0;
    this.nextAt = 0;
    this.error = null;        // what the last correction asked us to absorb
    this.errorLeft = 0;
    this._st = {};
  }

  /** @param {object} msg a MSG.SNAP  @param {number} now seconds, local clock */
  receive(msg, now) {
    this.prev = this.next;
    this.prevAt = this.nextAt;
    this.next = readSnapshot(msg, this.next === null ? [] : this.next.map((c) => ({ ...c })));
    this.nextAt = now;
    if (!this.prev) this.prev = this.next.map((c) => ({ ...c }));

    this.race.clock = msg.c;
    this.race.state = msg.st;
    this.race.lights = msg.l;

    // Fold the host's answer for our own car into a correction rather than
    // writing it straight on. Anything huge - a spin we did not predict, or a
    // reconnect - is not worth easing in and is simply taken.
    const me = this.race.field.indexOf(this.race.player);
    const truth = this.next[me];
    if (!truth) return;
    const car = this.race.player;
    const off = Math.abs(this.race.track.delta(car.s, truth.s));
    if (off > HARD_RESET) {
      Object.assign(car, {
        s: truth.s, n: truth.n, psi: truth.psi, speed: truth.speed,
        progress: truth.progress,
      });
      this.error = null;
      return;
    }
    // In the pits the host is simply right. `s` there is a distance down the
    // pit ribbon, not a lap position, so easing towards it with `track.delta`
    // would interpolate between two different coordinate systems.
    if (truth.onPit || car.onPit) {
      Object.assign(car, {
        n: truth.n, psi: truth.psi, speed: truth.speed, tyre: truth.tyre,
        progress: truth.progress, lap: truth.lap, place: truth.place,
        finished: truth.finished,
      });
      if (truth.onPit && !car.onPit && this.race.pits) {
        car.useRoad(this.race.pits.road, truth.s, truth.n);
      } else if (!truth.onPit && car.onPit) {
        car.useRoad(this.race.track, truth.s, truth.n);
      } else {
        car.s = truth.s;
      }
      car.onPit = truth.onPit;
      car.sync();
      this.error = null;
      return;
    }
    car.tyre = truth.tyre;
    this.error = {
      s: this.race.track.delta(car.s, truth.s),
      n: truth.n - car.n,
      psi: truth.psi - car.psi,
      speed: truth.speed - car.speed,
    };
    this.errorLeft = BLEND;
    car.progress = truth.progress;
    car.lap = truth.lap;
    car.place = truth.place;
    car.finished = truth.finished;
  }

  /**
   * Advance a frame.
   *
   * @param {number} dt   seconds since the last frame
   * @param {object} input the local player's buttons
   * @param {number} now  local clock, matching what `receive` was given
   */
  update(dt, input, now) {
    const race = this.race;
    if (!this.next) return;

    // Our own car runs the real physics against the real buttons - but only
    // once the lights have gone out. The host holds the grid still through the
    // countdown, and a guest that predicts through it has driven most of a lap
    // before the race has started.
    // ... and only while it is out on the circuit. A car in the pits is not
    // being driven: it is on a different ribbon, braking to a mark, held
    // still by the crew. Predicting through that drives it out from under
    // Guido and hands the correction an error it can never absorb - the same
    // reason the countdown is excluded, for the same reason.
    const car = race.player;
    if (!car.finished && !car.onPit && race.state === State.RACING) {
      input.applyTo(car, dt, race.physics);
      race.driverAidFor?.(car, dt);
      car.step(dt);
    }

    // ... then absorbs whatever the host disagreed about, a slice at a time.
    if (this.error && this.errorLeft > 0) {
      const take = Math.min(1, dt / this.errorLeft);
      car.s = race.track.wrap(car.s + this.error.s * take);
      car.n += this.error.n * take;
      car.psi += this.error.psi * take;
      car.speed += this.error.speed * take;
      this.error.s -= this.error.s * take;
      this.error.n -= this.error.n * take;
      this.error.psi -= this.error.psi * take;
      this.error.speed -= this.error.speed * take;
      this.errorLeft -= dt;
      car.sync();
    }

    // Everyone else is drawn between the two snapshots we have. Extrapolating
    // past the newest one is deliberately capped: a dropped packet should show
    // as a car that hesitates, never as one that drives through a wall.
    const span = Math.max(1e-3, this.nextAt - this.prevAt);
    const t = THREE.MathUtils.clamp((now - this.prevAt) / span, 0, 1.4);
    for (let i = 0; i < race.field.length; i++) {
      const rival = race.field[i];
      if (rival === car) continue;
      const a = this.prev[i];
      const b = this.next[i];
      if (!a || !b) continue;
      rival.tyre = b.tyre;
      // A rival in the pits is on the other ribbon, where `s` means something
      // else entirely. Interpolating it as a lap position draws the car out
      // in the middle of the circuit; take the newest packet as it is.
      if (b.onPit || a.onPit !== b.onPit) {
        const road = b.onPit ? this.race.pits?.road : this.race.track;
        if (road) {
          rival.road = road;
          rival.onPit = b.onPit;
          rival.s = b.s;
          const pst = road.sample(rival.s, this._st);
          rival.n = THREE.MathUtils.clamp(b.n, road.limit(pst, -1), road.limit(pst, 1));
          rival.psi = b.psi;
          rival.speed = b.speed;
          rival.progress = b.progress;
          rival.lap = b.lap;
          rival.place = b.place;
          rival.finished = b.finished;
          rival.sync();
          continue;
        }
      }
      // Interpolate along the track, not through the world: two cars either
      // side of the start line are 2 km apart in `s` and touching in fact.
      rival.s = race.track.wrap(a.s + race.track.delta(a.s, b.s) * t);
      // Clamped to the road. Extrapolating past the newest snapshot is what
      // keeps a dropped packet from freezing the field, but nothing justifies
      // drawing a car through the wall - and on a lossy link the gaps get long
      // enough that plain extrapolation does exactly that.
      const st = race.track.sample(rival.s, this._st);
      rival.n = THREE.MathUtils.clamp(a.n + (b.n - a.n) * t,
        race.track.limit(st, -1), race.track.limit(st, 1));
      rival.psi = a.psi + (b.psi - a.psi) * t;
      rival.speed = a.speed + (b.speed - a.speed) * t;
      rival.progress = a.progress + (b.progress - a.progress) * t;
      rival.lap = b.lap;
      rival.place = b.place;
      rival.finished = b.finished;
      rival.slip = b.slip;
      rival.gear = b.gear;
      rival.sync();
    }

    // Places come from the host, but the *order* is ours to sort - the HUD and
    // the results screen read `race.order`, and without this it still holds
    // the grid from before the lights went out.
    race.updateOrder();
  }
}
