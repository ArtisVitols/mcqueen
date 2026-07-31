/** Lap counter, race position, speed and the start-light gantry. */
export class Hud {
  constructor(root) {
    this.lapNow = root.querySelector('#lap-now');
    this.lapTotal = root.querySelector('#lap-total');
    this.place = root.querySelector('#place');
    this.placeTotal = root.querySelector('#place-total');
    this.speed = root.querySelector('#speed');
    this.lights = root.querySelector('#lights');
    this.bulbs = [...root.querySelectorAll('#lights .bulb')];
    this.flash = root.querySelector('#flash');
    this._lap = -1;
    this._place = -1;
    this._speed = -1;
  }

  setLaps(total) {
    this.lapTotal.textContent = total;
  }

  setField(n) {
    this.placeTotal.textContent = n;
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
