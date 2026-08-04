/** Lap counter, race position, speed and the start-light gantry. */
export class Hud {
  constructor(root) {
    this.lapNow = root.querySelector('#lap-now');
    this.lapTotal = root.querySelector('#lap-total');
    this.place = root.querySelector('#place');
    this.placeTotal = root.querySelector('#place-total');
    this.speed = root.querySelector('#speed');
    this.gear = root.querySelector('#gear');
    this.lights = root.querySelector('#lights');
    this.bulbs = [...root.querySelectorAll('#lights .bulb')];
    this.flash = root.querySelector('#flash');
    this.tyres = root.querySelector('#tyres');
    this.tyreBar = root.querySelector('#tyre-bar');
    this.tyreCall = root.querySelector('#tyre-call');
    this._lap = -1;
    this._place = -1;
    this._speed = -1;
    this._gear = -1;
    this._tyre = -1;
    this._call = null;
  }

  /** Show the tyre bar only where there is a pit road to drive into. */
  setTyres(enabled) {
    this.tyres.classList.toggle('hidden', !enabled);
    this._tyre = -1;
  }

  setLaps(total) {
    this.lapTotal.textContent = total;
  }

  setField(n) {
    this.placeTotal.textContent = n;
  }

  /**
   * Tyre life, and whether to shout about it.
   *
   * @param {number} tyre  1 fresh to 0 worn out
   * @param {string|null} call  'PIT!' when they need changing, 'PIT →' while
   *   the entry is open, null otherwise
   */
  setTyre(tyre, call) {
    // Rounded before comparing: the bar changes by a millionth every step and
    // rewriting a style every frame is how a HUD costs frames.
    const pct = Math.round(Math.max(0, Math.min(1, tyre)) * 100);
    if (pct !== this._tyre) {
      this._tyre = pct;
      this.tyreBar.style.width = `${pct}%`;
      // Green through amber to red. Hue alone, so it never goes muddy.
      this.tyreBar.style.backgroundColor = `hsl(${Math.round(pct * 1.25)} 72% 52%)`;
    }
    if (call !== this._call) {
      this._call = call;
      this.tyreCall.textContent = call || '';
      this.tyreCall.classList.toggle('hidden', !call);
    }
  }

  update(car, totalLaps) {
    const lap = Math.min(totalLaps, Math.max(1, car.lap));
    if (lap !== this._lap) {
      this.lapNow.textContent = lap;
      this._lap = lap;
    }
    if (car.place !== this._place) {
      this.place.textContent = car.place;
      this._place = car.place;
    }
    const kmh = Math.round(car.speedKmh / 5) * 5;
    if (kmh !== this._speed) {
      this.speed.textContent = kmh;
      this._speed = kmh;
    }
    // Only the models with a gearbox have a gear worth showing.
    const gear = car.physics?.geared ? car.gear + 1 : 0;
    if (gear !== this._gear) {
      this.gear.textContent = gear ? `GEAR ${gear}` : '';
      this.gear.classList.toggle('hidden', !gear);
      this._gear = gear;
    }
  }

  /** `lit` red bulbs on; `go` switches the whole gantry to green. */
  setLights(lit, go) {
    this.lights.classList.remove('hidden');
    this.lights.classList.toggle('go', go);
    this.bulbs.forEach((b, i) => b.classList.toggle('on', go || i < lit));
  }

  hideLights() {
    this.lights.classList.add('hidden');
  }

  /** Brief full-screen tint - used when a lap is completed. */
  pulse(colour) {
    this.flash.style.background = colour;
    this.flash.classList.remove('run');
    void this.flash.offsetWidth;      // restart the animation
    this.flash.classList.add('run');
  }
}
