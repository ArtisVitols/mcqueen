/**
 * Touch and keyboard controls.
 *
 * Landscape layout: steering arrows under the left thumb, gas and brake under
 * the right. Buttons are tracked by pointer id rather than with click events
 * so both thumbs work at once, and a finger that slides off a button releases
 * it instead of sticking down.
 */
export class Input {
  constructor(root) {
    this.state = { left: false, right: false, gas: false, brake: false };
    this.buttons = new Map();       // element -> action
    this.active = new Map();        // pointerId -> action

    for (const el of root.querySelectorAll('[data-action]')) {
      this.buttons.set(el, el.dataset.action);
    }

    const press = (action, on) => {
      if (action) this.state[action] = on;
      for (const [el, a] of this.buttons) el.classList.toggle('down', this.state[a]);
    };

    const hit = (x, y) => {
      for (const [el, action] of this.buttons) {
        const r = el.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return action;
      }
      return null;
    };

    const release = (id) => {
      const action = this.active.get(id);
      if (!action) return;
      this.active.delete(id);
      // Another finger may still be holding the same button.
      if (![...this.active.values()].includes(action)) press(action, false);
    };

    root.addEventListener('pointerdown', (e) => {
      const action = hit(e.clientX, e.clientY);
      if (!action) return;
      e.preventDefault();
      this.active.set(e.pointerId, action);
      press(action, true);
    });

    root.addEventListener('pointermove', (e) => {
      if (!this.active.has(e.pointerId)) return;
      const action = hit(e.clientX, e.clientY);
      if (action === this.active.get(e.pointerId)) return;
      release(e.pointerId);
      if (action) {
        this.active.set(e.pointerId, action);
        press(action, true);
      }
    });

    for (const type of ['pointerup', 'pointercancel']) {
      root.addEventListener(type, (e) => release(e.pointerId));
    }

    const KEYS = {
      ArrowLeft: 'left', KeyA: 'left',
      ArrowRight: 'right', KeyD: 'right',
      ArrowUp: 'gas', KeyW: 'gas', Space: 'gas',
      ArrowDown: 'brake', KeyS: 'brake',
    };
    addEventListener('keydown', (e) => {
      const a = KEYS[e.code];
      if (a) { e.preventDefault(); press(a, true); }
    });
    addEventListener('keyup', (e) => {
      const a = KEYS[e.code];
      if (a) { e.preventDefault(); press(a, false); }
    });
    // Losing focus mid-corner should not leave the throttle pinned.
    addEventListener('blur', () => {
      for (const a of Object.keys(this.state)) press(a, false);
      this.active.clear();
    });
  }

  /**
   * Feed the current control state into a car.
   *
   * Two buttons give a steer input of exactly -1, 0 or 1. Arcade integrates
   * that straight into the heading and feels fine, but a model with tyre
   * forces needs a wheel that arrives somewhere rather than snapping to full
   * lock - so those ramp it, at a rate the model chooses.
   */
  applyTo(car, dt = 0, physics = null) {
    const s = this.state;
    const want = (s.right ? 1 : 0) - (s.left ? 1 : 0);
    const ramp = physics?.steerRamp || 0;
    if (ramp > 0 && dt > 0) {
      const step = ramp * dt * (want === 0 ? 1.8 : 1);   // let go faster than you turn
      car.steerCmd += Math.max(-step, Math.min(step, want - car.steerCmd));
    } else {
      car.steerCmd = want;
    }
    // Under a model with a driver aid the command is a lane request and the
    // aid works out the lock; otherwise it goes straight to the tyres.
    if (!physics?.assisted) car.steer = car.steerCmd;
    car.throttle = s.gas ? 1 : 0;
    car.brake = s.brake ? 1 : 0;
  }

  reset() {
    for (const k of Object.keys(this.state)) this.state[k] = false;
    this.active.clear();
    for (const el of this.buttons.keys()) el.classList.remove('down');
  }
}
