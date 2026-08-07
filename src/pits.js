import { Vector3 } from 'three';
import { Track } from './track.js';

/**
 * The pit road: a second ribbon, alongside the lap.
 *
 * A pit lane cannot be "more `n`". Track space is one ribbon and the
 * arc-length scale `1 + n * kappa` degenerates a long way off the centreline,
 * so a road 90 m inboard is not somewhere the lap coordinate can reach. What
 * it *is* is another ribbon with its own stations, joined to the lap at two
 * points.
 *
 * Yoyleland's is real geometry, not something invented: a straight chord of
 * asphalt running from about s = 2357, past the start/finish, to s = 460, with
 * `Asphalt.002` and a fence along its inboard side as the pit wall. Because
 * the circuit curves and the pit road does not, its offset swings from about
 * n = -40 at the ends out to n = -95 in the middle - and at both ends the
 * paving runs continuously into the racing surface, which is what makes the
 * handover invisible.
 *
 * `PitRoad` extends `Track` and inherits all of it - sample, limit, rise,
 * slope, position, normal, orient. Two things differ:
 *
 *   - **It has ends.** `wrap` clamps instead of wrapping, and `span` stops at
 *     the last station instead of blending back round to the first.
 *   - **Progress is mapped, not accumulated.** A car in the pits still has to
 *     have a place in the race, and the chord is *shorter* than the arc it
 *     bypasses - so counting its own metres would make the pit lane a
 *     shortcut. `lapAt` maps distance along the ribbon onto the stretch of lap
 *     it replaces, which makes the two paths worth exactly the same and leaves
 *     the time cost where it belongs: the speed limit and the stop.
 *
 * That inheritance is the whole trick. `Car.step` does not change: it drives
 * whatever `car.road` is, and lap counting stays with `car.track`, so a pit
 * stop can never become a lap-counting bug.
 */
export class PitRoad extends Track {
  /** @param {object} data  the `pit` block from a track's JSON */
  constructor(data) {
    super({
      ...data,
      lapLength: data.length,
      stationCount: data.x.length,
      stationStep: data.stationStep,
    });
    this.length = data.length;
    this.entryS = data.entryS;        // lap s where the ribbon leaves the road
    this.exitS = data.exitS;          // ... and where it rejoins
    this.lapSpan = data.lapSpan;      // lap metres between them, forwards
    this.speedLimit = data.speedLimit;
    this.boxes = data.boxes || [];
    this.lapMap = null;               // filled by mapOnto, see lapAt
  }

  /** A pit road has ends. */
  wrap(d) {
    return d < 0 ? 0 : d > this.length ? this.length : d;
  }

  /** No station is "one past the end": a pit road does not come round again. */
  idx(i) {
    return i < 0 || i >= this.count ? -1 : i;
  }

  /** Stations either side of `d`, never blending past the last one. */
  span(d) {
    const last = this.count - 1;
    const f = Math.max(0, Math.min(last, this.wrap(d) / this.step));
    const i = Math.min(last - 1, Math.floor(f));
    return [i, i + 1, f - i];
  }

  /**
   * Where a car `d` metres down the pit road sits in lap terms.
   *
   * Not its own length: the chord is shorter than the arc, and paying it out
   * as lap progress would hand a place to anybody who pitted.
   *
   * With `mapOnto` run, this is *measured* - each station's real place on the
   * lap - rather than shared out in proportion. Both cost the same lap metres
   * end to end, so neither is a shortcut, but only the measured one agrees
   * with where the car can be seen to be, and the running order is drawn from
   * exactly this number.
   */
  lapAt(d) {
    if (!this.lapMap) return this.entryS + (this.wrap(d) / this.length) * this.lapSpan;
    const [i, j, t] = this.span(d);
    return this.entryS + this.lapMap[i] * (1 - t) + this.lapMap[j] * t;
  }

  /**
   * Measure each station against the circuit, once, at load.
   *
   * Forced to increase, because the running order reads this and a station
   * that projects a metre behind its neighbour would show as a car going
   * backwards; and rescaled to span exactly `lapSpan`, because the pit road
   * has to be worth precisely the stretch of lap it replaces - that is the
   * property that stops it being either a shortcut or a penalty in its own
   * right, on top of the limit and the stop.
   */
  mapOnto(track) {
    const lap = new Float64Array(this.count);
    const p = new Vector3();
    const st = {};
    let hint = this.entryS;
    let run = -Infinity;
    for (let i = 0; i < this.count; i++) {
      this.sample(i * this.step, st);
      this.position(st, 0, p);
      const hit = track.project(p.x, p.z, hint, 260);
      if (hit) hint = hit.s;
      run = Math.max(run, track.delta(this.entryS, hint));
      lap[i] = run;
    }
    const span = lap[this.count - 1] - lap[0];
    if (!(span > 1)) return;                 // nothing sensible measured
    for (let i = 0; i < this.count; i++) {
      lap[i] = (lap[i] - lap[0]) * this.lapSpan / span;
    }
    this.lapMap = lap;
  }

  /**
   * The reverse, for lining a car up on entry.
   *
   * @param {number} ahead  lap metres travelled since `entryS`, already
   *   unwrapped by the caller. It has to be, because a pit road runs through
   *   the start/finish - Yoyleland's enters at s = 2394 of a 2817 m lap - so
   *   subtracting raw `s` values goes negative the moment the car crosses the
   *   line and drops it back to the pit entry mid-lane.
   */
  distAt(ahead) {
    return (this.wrap2(ahead) / this.lapSpan) * this.length;
  }

  /** Clamp a lap offset into the stretch this ribbon covers. */
  wrap2(ahead) {
    return ahead < 0 ? 0 : ahead > this.lapSpan ? this.lapSpan : ahead;
  }

  /** The box this car uses, as {d, n}. One each, in grid order. */
  boxFor(index) {
    return this.boxes[index % this.boxes.length];
  }
}

/**
 * How close to the inside edge a car has to be, in the entry taper, before it
 * is taken to have committed to the pits.
 *
 * The two ribbons overlap in space through the taper, so the handover itself
 * is invisible - but it still has to be *asked for*, or a car running a low
 * line would be dragged into the pits every lap.
 */
export const ENTRY_REACH = 2.5;

/** Length of the taper at each end, in lap metres. */
export const TAPER = 70;
