import * as THREE from 'three';
import { Track } from './track.js';
import { Race, State } from './race.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { Audio } from './audio.js';
import { loadCar, loadTrack, disposeTrack, assetUrl } from './models.js';
import * as Settings from './settings.js';
import { QUALITY, DIFFICULTY, LAP_CHOICES } from './settings.js';

const dom = (id) => document.getElementById(id);

class Game {
  constructor() {
    this.settings = Settings.load();
    this.canvas = dom('scene');
    this.input = new Input(dom('controls'));
    this.hud = new Hud(dom('hud'));
    this.audio = new Audio();
    this.carSpecs = [];
    this.models = new Map();
    this.race = null;
    this.raf = 0;

    this.camPos = new THREE.Vector3();
    this.camAim = new THREE.Vector3();
    this.camN = 0;
    this._camSt = {};
    this._aimSt = {};
    this._v = new THREE.Vector3();
    this._w = new THREE.Vector3();
    this._up = new THREE.Vector3();
  }

  // ---------------------------------------------------------------- startup

  async boot() {
    this.initRenderer();
    const status = dom('loading-status');
    const bar = dom('loading-bar');

    const setProgress = (frac, text) => {
      bar.style.width = `${Math.round(frac * 100)}%`;
      if (text) status.textContent = text;
    };

    setProgress(0.05, 'Reading the calendar…');
    const [cars, tracks] = await Promise.all([
      fetch(assetUrl('cars.json')).then((r) => r.json()),
      fetch(assetUrl('tracks.json')).then((r) => r.json()),
    ]);
    this.carSpecs = cars.cars;
    this.trackSpecs = tracks.tracks;
    if (!this.trackSpecs.some((t) => t.id === this.settings.track)) {
      this.settings.track = this.trackSpecs[0].id;
    }

    const spec = this.trackSpec();
    setProgress(0.15, `Building ${spec.short}…`);
    await this.loadTrackById(this.settings.track, (f) => setProgress(0.15 + 0.55 * f));

    for (let i = 0; i < this.carSpecs.length; i++) {
      const car = this.carSpecs[i];
      setProgress(0.7 + 0.3 * (i / this.carSpecs.length), `Waking up ${car.name}…`);
      const model = await loadCar(car);
      model.object.visible = false;
      this.scene.add(model.object);
      this.models.set(car.id, model);
    }

    setProgress(1, 'Ready!');
    dom('build-tag').textContent = `build ${globalThis.__BUILD__ || 'dev'}`;
    this.buildMenu();
    dom('loading').classList.add('hidden');
    dom('menu').classList.remove('hidden');
    this.startIdleCamera();
    addEventListener('resize', () => this.resize());
    this.watchOrientation();
  }

  trackSpec(id = this.settings.track) {
    return this.trackSpecs.find((t) => t.id === id) || this.trackSpecs[0];
  }

  /**
   * Swap in a circuit: its racing line and its model, which is scaled to match
   * because two of the three are modelled at roughly 1:15. Only one track is
   * ever resident - the big one is 420k triangles and a phone should not be
   * holding three.
   */
  async loadTrackById(id, onProgress) {
    const spec = this.trackSpec(id);
    const track = await Track.load(assetUrl(spec.data));
    const scene = await loadTrack(spec.model, track.modelScale, (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    }, spec.asphalt || []);
    if (this.trackScene) {
      this.scene.remove(this.trackScene);
      disposeTrack(this.trackScene);
    }
    this.track = track;
    this.trackScene = scene;
    this.scene.add(scene);
    this.settings.track = spec.id;
    return track;
  }

  initRenderer() {
    const q = QUALITY[this.settings.quality] || QUALITY.high;
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio, q.pixelRatio));
    renderer.shadowMap.enabled = q.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x8fc4ee);
    scene.fog = new THREE.Fog(0x9ecbf0, 260, q.fog);
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(62, 2, 0.6, 3200);
    scene.add(this.camera);

    const sun = new THREE.DirectionalLight(0xfff2dd, 3.1);
    sun.position.set(-320, 420, 260);
    sun.castShadow = q.shadows;
    if (q.shadows) {
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.near = 20;
      sun.shadow.camera.far = 320;
      // Tight box around the player: 1024 texels over the old 140 m spread
      // barely registered a car. 44 m gives ~2 cm texels.
      const r = 22;
      Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r });
      sun.shadow.bias = -0.0006;
      sun.shadow.normalBias = 0.12;
      // Without this the frustum stays at its constructed +/-5 default and the
      // shadows quietly never appear.
      sun.shadow.camera.updateProjectionMatrix();
    }
    scene.add(sun);
    this.sun = sun;
    this.sunTarget = new THREE.Object3D();
    scene.add(this.sunTarget);
    sun.target = this.sunTarget;

    // Less flat fill than before: the sun has to win, or a shadow on dark
    // asphalt is invisible and the cars look pasted on.
    scene.add(new THREE.HemisphereLight(0xbcd8ff, 0x4a4741, 0.85));
    scene.add(new THREE.AmbientLight(0xffffff, 0.25));
    this.resize();
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  watchOrientation() {
    const check = () => {
      const portrait = innerHeight > innerWidth;
      dom('rotate').classList.toggle('hidden', !portrait);
    };
    addEventListener('resize', check);
    addEventListener('orientationchange', check);
    check();
  }

  // ------------------------------------------------------------------- menu

  buildMenu() {
    dom('btn-start').onclick = () => this.startRace();
    dom('btn-options').onclick = () => this.showOptions();
    dom('btn-back').onclick = () => {
      Settings.save(this.settings);
      dom('options').classList.add('hidden');
      dom('menu').classList.remove('hidden');
      this.setIdleCar(this.settings.car);
    };
    dom('btn-menu').onclick = () => this.toMenu();
    dom('btn-again').onclick = () => this.startRace();
    dom('btn-pause').onclick = () => this.pauseRace();
    dom('btn-resume').onclick = () => this.resumeRace();
    dom('btn-restart').onclick = () => {
      this.closePauseOverlay();
      this.startRace();
    };
    dom('btn-quit').onclick = () => {
      this.closePauseOverlay();
      this.toMenu();
    };

    this.buildCarPicker();
    this.buildTrackPicker();
    this.buildToggles();
    this.setIdleCar(this.settings.car);
  }

  buildCarPicker() {
    const wrap = dom('car-picker');
    wrap.innerHTML = '';
    for (const spec of this.carSpecs) {
      const b = document.createElement('button');
      b.className = 'card';
      b.dataset.car = spec.id;
      b.innerHTML = `<span class="chip" style="background:${spec.colour}">${spec.number}</span>
                     <span class="cname">${spec.name}</span>`;
      b.onclick = () => {
        this.settings.car = spec.id;
        Settings.save(this.settings);
        this.syncCarPicker();
        if (this.paused) this.requireRestart();
        else this.setIdleCar(spec.id);
      };
      wrap.appendChild(b);
    }
    this.syncCarPicker();
  }

  syncCarPicker() {
    for (const b of dom('car-picker').children) {
      b.classList.toggle('sel', b.dataset.car === this.settings.car);
    }
    const spec = this.carSpecs.find((c) => c.id === this.settings.car);
    dom('menu-car').textContent = spec ? spec.name : '';
    dom('menu-track').textContent = this.trackSpec().name;
  }

  buildTrackPicker() {
    const wrap = dom('track-picker');
    wrap.innerHTML = '';
    for (const spec of this.trackSpecs) {
      const b = document.createElement('button');
      b.className = 'card track';
      b.dataset.track = spec.id;
      b.innerHTML = `<span class="tname">${spec.short}</span>
                     <span class="tblurb">${spec.blurb}</span>`;
      b.onclick = () => this.pickTrack(spec.id);
      wrap.appendChild(b);
    }
    this.syncTrackPicker();
  }

  async pickTrack(id) {
    if (id === this.settings.track || this.switchingTrack) return;
    this.switchingTrack = true;
    const wrap = dom('track-picker');
    wrap.classList.add('busy');
    try {
      cancelAnimationFrame(this.raf);
      await this.loadTrackById(id);
      Settings.save(this.settings);
      this.syncTrackPicker();
      if (this.paused) this.requireRestart();
      else this.startIdleCamera();
    } catch (err) {
      console.error(err);
    } finally {
      wrap.classList.remove('busy');
      this.switchingTrack = false;
    }
  }

  syncTrackPicker() {
    for (const b of dom('track-picker').children) {
      b.classList.toggle('sel', b.dataset.track === this.settings.track);
    }
    dom('menu-track').textContent = this.trackSpec().name;
  }

  buildToggles() {
    const group = (el, values, current, label, onPick) => {
      el.innerHTML = '';
      for (const v of values) {
        const b = document.createElement('button');
        b.className = 'pill';
        b.textContent = label(v);
        b.classList.toggle('sel', v === current());
        b.onclick = () => {
          onPick(v);
          Settings.save(this.settings);
          for (const c of el.children) c.classList.remove('sel');
          b.classList.add('sel');
        };
        el.appendChild(b);
      }
    };

    group(dom('opt-laps'), LAP_CHOICES, () => this.settings.laps,
      (v) => `${v}`, (v) => { this.settings.laps = v; });

    group(dom('opt-difficulty'), Object.keys(DIFFICULTY), () => this.settings.difficulty,
      (v) => DIFFICULTY[v].label, (v) => { this.settings.difficulty = v; });

    group(dom('opt-quality'), Object.keys(QUALITY), () => this.settings.quality,
      (v) => QUALITY[v].label, (v) => {
        this.settings.quality = v;
        this.applyQuality();
      });

    group(dom('opt-sound'), [true, false], () => this.settings.sound,
      (v) => (v ? 'On' : 'Off'), (v) => {
        this.settings.sound = v;
        this.audio.setEnabled(v);
      });

    const vol = dom('opt-volume');
    vol.value = String(Math.round(this.settings.volume * 100));
    vol.oninput = () => {
      this.settings.volume = vol.value / 100;
      this.audio.setVolume(this.settings.volume);
    };
    vol.onchange = () => Settings.save(this.settings);
  }

  applyQuality() {
    const q = QUALITY[this.settings.quality];
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, q.pixelRatio));
    this.renderer.shadowMap.enabled = q.shadows;
    this.sun.castShadow = q.shadows;
    this.scene.fog.far = q.fog;
    this.scene.traverse((o) => { if (o.isMesh) o.material.needsUpdate = true; });
  }

  /**
   * @param {boolean} fromRace  true when opened with the pause button, which
   *   swaps BACK for resume/restart/menu and keeps the race frozen behind it.
   */
  showOptions(fromRace = false) {
    this.optionsFromRace = fromRace;
    dom('menu').classList.add('hidden');
    dom('options').classList.remove('hidden');
    dom('btn-back').classList.toggle('hidden', fromRace);
    dom('pause-actions').classList.toggle('hidden', !fromRace);
    dom('btn-resume').classList.remove('hidden');
  }

  /**
   * Called when a paused change - a different car or circuit - makes the
   * frozen race meaningless. Resuming into it would put the player in the
   * wrong car or on the wrong track, so that door is closed.
   */
  requireRestart() {
    this.race = null;
    dom('btn-resume').classList.add('hidden');
  }

  pauseRace() {
    if (!this.race || this.paused) return;
    this.paused = true;
    cancelAnimationFrame(this.raf);
    this.input.reset();
    this.audio.silenceEngines();
    dom('hud').classList.add('hidden');
    dom('controls').classList.add('hidden');
    this.showOptions(true);
  }

  closePauseOverlay() {
    Settings.save(this.settings);
    dom('options').classList.add('hidden');
    dom('pause-actions').classList.add('hidden');
    dom('btn-back').classList.remove('hidden');
    this.paused = false;
  }

  resumeRace() {
    if (!this.race) return this.toMenu();
    this.closePauseOverlay();
    dom('hud').classList.remove('hidden');
    dom('controls').classList.remove('hidden');
    // Laps or difficulty may have changed; apply what can be applied live.
    this.race.totalLaps = this.settings.laps;
    for (const car of this.race.field) car.totalLaps = this.settings.laps;
    this.hud.setLaps(this.settings.laps);
    this.audio.setEnabled(this.settings.sound);
    this.audio.setVolume(this.settings.volume);
    this._last = performance.now();
    this.loop(this._last);
  }

  toMenu() {
    cancelAnimationFrame(this.raf);
    this.paused = false;
    this.race = null;
    this.audio.silenceEngines();
    dom('result').classList.add('hidden');
    dom('options').classList.add('hidden');
    dom('pause-actions').classList.add('hidden');
    dom('btn-back').classList.remove('hidden');
    dom('hud').classList.add('hidden');
    dom('controls').classList.add('hidden');
    dom('menu').classList.remove('hidden');
    this.hud.hideLights();
    this.startIdleCamera();
  }

  // -------------------------------------------------------- attract screen

  setIdleCar(id) {
    for (const [key, m] of this.models) m.object.visible = key === id;
    this.idleCar = this.models.get(id);
  }

  startIdleCamera() {
    cancelAnimationFrame(this.raf);
    for (const [, m] of this.models) m.object.visible = false;
    this.setIdleCar(this.settings.car);

    // Park the showcase car on the start line and orbit it slowly.
    const st = this.track.sample(0, {});
    const pos = this.track.position(st, 0, new THREE.Vector3());
    const q = new THREE.Quaternion();
    this.track.orient(st, 0, q);
    if (this.idleCar) {
      this.idleCar.object.position.copy(pos);
      this.idleCar.object.quaternion.copy(q);
    }

    let t = 0;
    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();
    const aim = new THREE.Vector3();
    const UP = new THREE.Vector3(0, 1, 0);

    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      t += 0.004;
      const r = 9.5;
      this.camera.up.copy(UP);
      this.camera.position.set(
        pos.x + Math.cos(t) * r,
        pos.y + 2.6,
        pos.z + Math.sin(t) * r,
      );
      // Bias the framing so the car sits to the right of centre, clear of the
      // menu panel on the left.
      forward.subVectors(pos, this.camera.position).normalize();
      right.crossVectors(forward, UP).normalize();
      const halfWidth = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) *
        this.camera.aspect * r;
      aim.copy(pos).addScaledVector(right, -halfWidth * 0.34);
      aim.y = pos.y + 0.8;
      this.camera.lookAt(aim);

      this.sunTarget.position.copy(pos);
      this.sun.position.set(pos.x - 90, pos.y + 130, pos.z + 70);
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  // ------------------------------------------------------------------ race

  async startRace() {
    cancelAnimationFrame(this.raf);
    this.paused = false;
    dom('menu').classList.add('hidden');
    dom('options').classList.add('hidden');
    dom('pause-actions').classList.add('hidden');
    dom('btn-back').classList.remove('hidden');
    dom('result').classList.add('hidden');
    dom('hud').classList.remove('hidden');
    dom('controls').classList.remove('hidden');

    this.audio.setEnabled(this.settings.sound);
    this.audio.setVolume(this.settings.volume);
    await this.audio.start();
    this.goFullscreen();
    this.input.reset();

    for (const [, m] of this.models) m.object.visible = true;

    const entries = this.carSpecs.map((spec) => ({
      spec,
      object: this.models.get(spec.id).object,
    }));

    const race = new Race(this.track, entries, this.settings).build(this.settings.car);
    this.race = race;
    this.hud.setLaps(this.settings.laps);
    this.hud.setField(race.field.length);
    this.hud.setLights(0, false);
    this.hud.update(race.player, this.settings.laps);

    race.onLight = (lit, go) => {
      this.hud.setLights(lit, go);
      this.audio.beep(go);
      if (go) setTimeout(() => this.hud.hideLights(), 900);
    };
    race.onLap = () => this.hud.pulse('rgba(255,255,255,0.5)');
    race.onFinish = (placeCount, car) => {
      if (car === race.player) this.showResult(car);
    };

    // Snap the camera behind the player before the first frame.
    this.camN = race.player.n;
    this.placeCamera(race.player, 1);
    this.loop(performance.now());
  }

  /**
   * Chase camera, positioned in track space rather than by smoothing a world
   * position. Lerping towards a target that moves at 50 m/s leaves the camera
   * permanently metres adrift - far enough for rivals to slot in between it
   * and the player. Anchoring it a fixed distance back along the centreline
   * removes the longitudinal lag entirely, and it banks with the track for
   * free. Only the lateral offset is smoothed, so lane changes still glide.
   */
  placeCamera(car, blend) {
    const track = this.track;
    const back = 7.6 + Math.min(3.4, car.speed * 0.05);
    const height = 2.5 + Math.min(1.0, car.speed * 0.011);

    this.camN += (car.n - this.camN) * blend;

    const camSt = track.sample(car.s - back, this._camSt);
    const up = track.normal(camSt, this._up);
    track.position(camSt, this.camN, this.camPos).addScaledVector(up, height);

    // Aim just past the car so it sits in the lower third of the screen with
    // the road ahead filling the rest.
    const aimSt = track.sample(car.s + 7, this._aimSt);
    track.position(aimSt, this.camN, this.camAim)
      .addScaledVector(track.normal(aimSt, this._w), 1.0);

    this.camera.position.copy(this.camPos);
    this.camera.up.copy(up);
    this.camera.lookAt(this.camAim);
  }

  loop(now) {
    if (this.paused) return;
    this.raf = requestAnimationFrame((t) => this.loop(t));
    const dt = Math.min(0.1, (now - (this._last || now)) / 1000);
    this._last = now;

    const race = this.race;
    if (!race) return;

    race.update(dt, this.input);

    const player = race.player;
    this.placeCamera(player, 1 - Math.pow(0.0016, dt));
    this.hud.update(player, this.settings.laps);

    // Keep the shadow frustum on the player rather than the whole speedway.
    this.sunTarget.position.copy(player.position);
    this.sun.position.copy(player.position).add(this._v.set(-90, 130, 70));

    const rivals = race.order.filter((c) => c !== player);
    rivals.sort((a, b) =>
      a.position.distanceToSquared(player.position) - b.position.distanceToSquared(player.position));
    this.audio.update(player, rivals, race.state === State.RACING);

    this.renderer.render(this.scene, this.camera);
  }

  showResult(car) {
    const won = car.place === 1;
    this.audio.fanfare(won);
    dom('result-title').textContent = won ? 'YOU WIN!' : `P${car.place}`;
    dom('result-sub').textContent = won
      ? 'Ka-chow!'
      : `${ordinal(car.place)} out of ${this.race.field.length}`;
    dom('result-order').innerHTML = this.race.order.slice(0, 7).map((c, i) => {
      const spec = c.spec;
      return `<li class="${c === car ? 'me' : ''}">
        <span class="pos">${i + 1}</span>
        <span class="chip" style="background:${spec.colour}">${spec.number}</span>
        <span class="cname">${spec.name}</span></li>`;
    }).join('');
    dom('result').classList.remove('hidden');
  }

  goFullscreen() {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    }
    // Android honours this; iOS ignores it, hence the rotate overlay.
    screen.orientation?.lock?.('landscape').catch(() => {});
  }
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

const game = new Game();
game.boot().catch((err) => {
  console.error(err);
  dom('loading-status').textContent = `Could not start: ${err.message}`;
});
window.game = game;
