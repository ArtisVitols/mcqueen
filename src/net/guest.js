import * as THREE from 'three';
import { readSnapshot, SNAPSHOT_HZ } from '../net.js';
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
/**
 * How far behind the newest snapshot the rivals are drawn, in seconds.
 *
 * **Without this the guest never interpolates - it only ever extrapolates**,
 * and that is what "the other cars are jerky" is. Anchoring playback at the
 * arrival time of the newest packet means `t` is already 1 the instant it
 * lands, so every frame after that runs *past* it, is clamped, freezes, and
 * then jumps when the next one arrives. One snapshot interval of delay puts
 * playback between two known states, where interpolation is what it says it
 * is. Running on past the newest packet still happens - that is what stops a
 * dropped one freezing the field - it is just no longer the normal case.
 *
 * The cost is that a rival is drawn one interval further behind: 50 ms, about
 * 3.5 m at racing speed, on top of the round trip that was already there.
 */
const INTERP_DELAY = 1 / SNAPSHOT_HZ;
/**
 * How hard the playback clock's *rate* is trimmed to stay in step, and the
 * most it may be trimmed by.
 *
 * The error is only ever measured **when a packet arrives**, because that is
 * the one instant its correct value is known: playback should be at the older
 * of the two snapshots, about to traverse to the newer. Measuring it every
 * frame instead compares against a target that jumps forward once per packet,
 * so a filter chasing it lags by half a cycle - which put `t` at -0.44..0.42
 * instead of 0..1, froze the car for three frames of every six and then jumped
 * it 1.8 m. Trimming the rate rather than the position means nothing is ever
 * moved; it just runs a fraction fast or slow until it is back in step.
 */
const CLOCK_TRIM = 2.0;
const MAX_TRIM = 0.15;
// Beyond this much error there is no catching up smoothly - a long stall, or a
// host that has been paused - so take the jump and start again.
const CLOCK_RESET = 0.5;

export class GuestView {
  constructor(race) {
    this.race = race;
    this.prev = null;         // the snapshot before last
    this.next = null;         // ... and the newest
    this.prevAt = 0;
    this.nextAt = 0;
    // Playback runs on **host time**, not on arrival times and not on the
    // snapshot number.
    //
    // Arrival times jitter with the network, so interpolating over them varies
    // the replay rate packet by packet and reads as stutter even when nothing
    // was lost. The snapshot *number* is perfectly smooth but assumes the host
    // sends exactly every 1/SNAPSHOT_HZ, and it does not: `startPump` is a
    // `setInterval` on a phone, and even a fixed-step test loop lands on 7
    // frames of 1/120 rather than 6, because 6/120 is a hair under 1/20. That
    // is a 14% error in the replay rate - worse than the problem being fixed.
    //
    // What is left is `msg.c`, the host's own race clock, which measures the
    // time that actually elapsed between two snapshots. Its one flaw is that
    // it is **reset to zero when the lights go green**, so it is accumulated
    // into a monotonic timeline here rather than used raw.
    this.prevClock = 0;
    this.nextClock = 0;
    this.lastC = null;        // the raw race clock of the newest snapshot
    this.clock = 0;           // where playback has got to, in host time
    this.trim = 0;            // rate correction, measured once per packet
    this.seq = null;          // newest snapshot applied, for dropping stale ones

    this.error = null;        // what the last correction asked us to absorb
    this.errorLeft = 0;
    this._st = {};
  }

  /** @param {object} msg a MSG.SNAP  @param {number} now seconds, local clock */
  receive(msg, now) {
    // **A packet older than the one already applied is thrown away.** Jitter
    // reorders them - more so the worse the link - and taking one at face
    // value winds the playback clock *backwards*, so the span between the two
    // snapshots goes negative and every car being interpolated lurches.
    //
    // On `n`, never on `c`: the race clock is reset to zero when the lights go
    // green, so using it here freezes the guest on the grid for the first five
    // seconds of every race.
    if (this.seq !== null && msg.n <= this.seq) return;
    this.seq = msg.n ?? null;
    this.prev = this.next;
    this.prevAt = this.nextAt;
    this.next = readSnapshot(msg, this.next === null ? [] : this.next.map((c) => ({ ...c })));
    this.nextAt = now;
    // Accumulate the host's elapsed time. A backwards step is the countdown
    // handing over to the race, which is a reset and not a rewind: charge it
    // one nominal interval so the timeline keeps moving forwards.
    const step = (this.lastC === null || msg.c < this.lastC)
      ? 1 / SNAPSHOT_HZ : msg.c - this.lastC;
    this.lastC = msg.c;
    this.prevClock = this.nextClock;
    this.nextClock += step;
    if (!this.prev) {
      this.prev = this.next.map((c) => ({ ...c }));
      // First packet: start playback where it should sit rather than catching
      // up to it over the opening seconds.
      this.prevClock = this.nextClock - INTERP_DELAY;
      this.clock = this.prevClock;
    }
    // Where playback ought to be *at this instant*: on the older of the two
    // snapshots it is about to interpolate between. This is the only moment
    // that is true, which is why the error is taken here and nowhere else.
    const err = (this.nextClock - INTERP_DELAY) - this.clock;
    if (Math.abs(err) > CLOCK_RESET) { this.clock += err; this.trim = 0; } else this.trim = err;

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
    // The pits come *first*, before the hard-reset test below.
    //
    // That test measures `track.delta(car.s, truth.s)`, and on the pit ribbon
    // `s` is a distance down a different road - so the moment either end is in
    // the pits it compares two coordinate systems, decides the guest is 300 m
    // out, and "fixes" it by writing a pit distance onto a car still on the
    // circuit. That is a genuine teleport, and it is what the reset exists to
    // prevent rather than cause.
    //
    // In the pits the host is simply right: there is nothing to ease towards,
    // because the car is braking to a mark and then held still by the crew.
    if (truth.onPit || car.onPit) {
      Object.assign(car, {
        n: truth.n, speed: truth.speed, tyre: truth.tyre,
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
      // The heading goes on *after* the handover, never before. `useRoad`
      // rotates `psi` out of one ribbon's frame and into the other's, to keep
      // the car pointing the way it was pointing - and the number on the wire
      // is already in the frame it is being sent for, so applying it first
      // would have it turned twice.
      car.psi = truth.psi;
      car.onPit = truth.onPit;
      // The phase of the stop, which is what starts the crew. Without it a
      // guest's own car was never `service` and Guido simply never came out.
      car.pit = truth.pit;
      car.sync();
      this.error = null;
      return;
    }
    // Anything huge - a spin we did not predict, or a reconnect - is not worth
    // easing in and is simply taken. Safe here: both ends are on the circuit.
    const off = Math.abs(this.race.track.delta(car.s, truth.s));
    if (off > HARD_RESET) {
      Object.assign(car, {
        s: truth.s, n: truth.n, psi: truth.psi, speed: truth.speed,
        progress: truth.progress, tyre: truth.tyre,
      });
      this.error = null;
      return;
    }
    car.tyre = truth.tyre;
    car.pit = truth.pit;
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
    //
    // Playback advances in real time on the *host's* clock and is held one
    // snapshot behind it, so the normal case is genuine interpolation between
    // two known states. Anchoring on arrival times instead meant `t` was 1 the
    // moment a packet landed and every frame after it extrapolated, clamped,
    // froze and then jumped - which is exactly what a rival looked like.
    this.clock += dt * (1 + THREE.MathUtils.clamp(this.trim * CLOCK_TRIM,
      -MAX_TRIM, MAX_TRIM));
    const span = Math.max(1e-3, this.nextClock - this.prevClock);
    // Running on past the newest snapshot is capped in *time*, not as a
    // fraction of the span. As a fraction it grew with the gap - so the more
    // packets a link lost, the further a car was thrown past the last thing
    // known about it, and the bigger the snap back when the next one arrived.
    // One send interval of run-on costs the same few metres however bad the
    // link gets, which is the behaviour worth having.
    const t = THREE.MathUtils.clamp((this.clock - this.prevClock) / span,
      0, 1 + (1 / SNAPSHOT_HZ) / span);
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
          rival.pit = b.pit;
          rival.out = b.out;
          rival.speed = b.speed;
          rival.progress = b.progress;
          rival.lap = b.lap;
          rival.place = b.place;
          rival.finished = b.finished;
          rival.sync();
          continue;
        }
      }
      // Back on the circuit, and *said so* rather than assumed.
      //
      // The branch above only moves a car between ribbons when it can see the
      // change happen - `a.onPit !== b.onPit`. Lose the packet where it flips
      // and both snapshots read "on the circuit" while this copy of the car is
      // still on the pit ribbon, so its lap position is interpreted as a pit
      // distance for the rest of the race. It showed up as a guest drawing a
      // car off the road seventeen hundred times on a lossy link. The newest
      // packet is authoritative about which road a car is on; take its word
      // every time, not only when it changes.
      rival.road = race.track;
      rival.onPit = false;
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
      rival.pit = b.pit;
      rival.out = b.out;
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
