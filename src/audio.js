/**
 * All game audio, synthesised with WebAudio.
 *
 * Nothing is downloaded: the engines, tyres, crowd and start-light beeps are
 * all generated from oscillators and noise. That keeps the payload at zero
 * bytes and sidesteps sample licensing entirely.
 *
 * The context can only start from a user gesture, so start() is called from
 * the START button.
 */

const RIVAL_VOICES = 2;   // a couple of shared voices stand in for the pack

export class Audio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.enabled = true;
    this.volume = 0.8;
  }

  async start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    this.master.connect(ctx.destination);

    // Tame the peaks so a phone speaker does not distort with seven engines.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 6;
    comp.connect(this.master);
    this.bus = comp;

    this.noise = makeNoiseBuffer(ctx);
    this.player = this.makeEngine(0.5);
    this.rivals = Array.from({ length: RIVAL_VOICES }, () => this.makeEngine(0.16));
    this.tyres = this.makeTyres();
    this.crowd = this.makeCrowd();
    this.ready = true;
  }

  /**
   * One engine voice: a stack of detuned saws an octave apart through a
   * lowpass, plus a breath of noise for induction roar.
   */
  makeEngine(level) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.bus);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    filter.Q.value = 3;
    filter.connect(out);

    const oscs = [];
    for (const [mult, gain, type] of [[1, 0.5, 'sawtooth'], [2, 0.3, 'sawtooth'],
                                      [3, 0.18, 'square'], [0.5, 0.4, 'sawtooth']]) {
      const o = ctx.createOscillator();
      o.type = type;
      const g = ctx.createGain();
      g.gain.value = gain * level;
      o.connect(g).connect(filter);
      o.start();
      oscs.push({ osc: o, mult });
    }

    const hiss = ctx.createBufferSource();
    hiss.buffer = this.noise;
    hiss.loop = true;
    const hissFilter = ctx.createBiquadFilter();
    hissFilter.type = 'bandpass';
    hissFilter.frequency.value = 1400;
    const hissGain = ctx.createGain();
    hissGain.gain.value = 0.05 * level;
    hiss.connect(hissFilter).connect(hissGain).connect(out);
    hiss.start();

    return { out, filter, oscs, hissFilter };
  }

  makeTyres() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 2600;
    band.Q.value = 9;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(band).connect(gain).connect(this.bus);
    src.start();
    return { gain, band };
  }

  makeCrowd() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 700;
    band.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(band).connect(gain).connect(this.bus);
    src.start();
    return { gain };
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? this.volume : 0;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = this.enabled ? v : 0;
  }

  /** Pitch and level one engine voice from a car's state. */
  driveEngine(voice, car, level) {
    if (!voice) return;
    const t = this.ctx.currentTime;
    const pace = Math.min(1, car.speed / car.topSpeed);
    // Models with a gearbox report a real gear and a real position within it.
    // The arcade model has neither, so fake the steps from speed - without
    // them the engine is one long slide from the line to the flag.
    const geared = car.physics?.geared;
    const gear = geared ? car.gear : Math.min(4, Math.floor(pace * 5));
    const within = geared ? car.rev : pace * 5 - Math.floor(pace * 5);
    const base = 52 + within * 62 + gear * 7;
    for (const { osc, mult } of voice.oscs) {
      osc.frequency.setTargetAtTime(base * mult, t, 0.05);
    }
    voice.filter.frequency.setTargetAtTime(500 + pace * 2600 + car.throttle * 800, t, 0.06);
    voice.out.gain.setTargetAtTime(level * (0.35 + 0.65 * car.throttle), t, 0.08);
  }

  /**
   * @param {Car} player
   * @param {Car[]} rivals  sorted by distance from the player, nearest first
   */
  update(player, rivals, racing) {
    if (!this.ready || !this.enabled) return;
    const t = this.ctx.currentTime;

    this.driveEngine(this.player, player, 1);

    for (let i = 0; i < this.rivals.length; i++) {
      const car = rivals[i];
      if (!car) {
        this.rivals[i].out.gain.setTargetAtTime(0, t, 0.2);
        continue;
      }
      const d = car.position.distanceTo(player.position);
      const near = Math.max(0, 1 - d / 60);
      this.driveEngine(this.rivals[i], car, near * near * 0.9);
    }

    const squeal = Math.max(player.slip, ...rivals.map((c) => (c ? c.slip * 0.4 : 0)));
    this.tyres.gain.gain.setTargetAtTime(squeal > 0.25 ? (squeal - 0.25) * 0.22 : 0, t, 0.05);
    this.tyres.band.frequency.setTargetAtTime(2200 + player.speed * 12, t, 0.1);

    this.crowd.gain.gain.setTargetAtTime(racing ? 0.035 : 0.015, t, 1.5);
  }

  /** Countdown blip. `go` makes it the higher, longer green-light tone. */
  beep(go = false) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = go ? 880 : 440;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.28, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + (go ? 1.1 : 0.22));
    osc.connect(gain).connect(this.bus);
    osc.start(t);
    osc.stop(t + (go ? 1.2 : 0.3));
  }

  /** Little rising fanfare on the chequered flag. */
  fanfare(won) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const notes = won ? [523, 659, 784, 1047] : [440, 415];
    notes.forEach((f, i) => {
      const t = ctx.currentTime + i * 0.16;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      osc.connect(gain).connect(this.bus);
      osc.start(t);
      osc.stop(t + 0.55);
    });
  }

  silenceEngines() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.player.out.gain.setTargetAtTime(0, t, 0.3);
    for (const v of this.rivals) v.out.gain.setTargetAtTime(0, t, 0.3);
    this.tyres.gain.gain.setTargetAtTime(0, t, 0.2);
  }
}

function makeNoiseBuffer(ctx) {
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    // Brown-ish noise: warmer and less hissy than white.
    last = (last + Math.random() * 2 - 1) * 0.5;
    d[i] = last;
  }
  return buf;
}
