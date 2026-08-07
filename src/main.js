import * as THREE from 'three';
import { Track } from './track.js';
import { Race, State } from './race.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { Audio } from './audio.js';
import { loadCar, loadTrack, disposeTrack, assetUrl } from './models.js';
import * as Settings from './settings.js';
import { QUALITY, DIFFICULTY, LAP_CHOICES } from './settings.js';
import { PHYSICS, driverAid } from './physics.js';
import { MSG, RemoteInput, packButtons, snapshot, SNAPSHOT_HZ, INPUT_HZ } from './net.js';
import { GuestView } from './net/guest.js';
import { Museum } from './museum.js';
import { PitCrew } from './pitcrew.js';

const dom = (id) => document.getElementById(id);

// Seconds of silence before the other phone counts as gone. Long enough to
// ride out a lift tunnel, short enough that nobody races a ghost.
const DROP_AFTER = 5;

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
    this.net = null;              // {role, link, view, remote, ...} when two up

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
    // Guido and Mack are in the game but not on the grid: one is the pit crew,
    // the other is parked in the pits. Everything that builds a field or lets
    // you pick a car uses `racerSpecs`; only loading and the museum walk the
    // full list.
    this.racerSpecs = this.carSpecs.filter((c) => c.racer !== false);
    if (!this.racerSpecs.some((c) => c.id === this.settings.car)) {
      this.settings.car = this.racerSpecs[0].id;
    }
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
      sun.shadow.mapSize.set(1024, 1024);
      sun.shadow.camera.near = 20;
      sun.shadow.camera.far = 320;
      // Tight box around the player: the old 140 m spread left a car a few
      // texels wide. 44 m over 1024 is ~4 cm per texel, which is plenty, and
      // going to 2048 measurably slowed the heaviest circuit for no gain.
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

  /**
   * Portrait asks for the phone to be turned; landscape goes fullscreen.
   *
   * Rotating the phone is **not** a user activation, so Chrome refuses
   * `requestFullscreen` from an orientationchange handler unless the page
   * still happens to hold activation from a recent tap. The free shot is
   * worth taking - it often lands - but the tap panel is what actually
   * delivers it, which is why the overlay has two states rather than one.
   */
  watchOrientation() {
    const el = dom('rotate');
    // Phones only. On a desktop - and in headless Chrome, where every browser
    // test runs at a landscape viewport - a fullscreen nag over the menu is
    // both wrong and would swallow the clicks those tests make.
    const phone = matchMedia('(hover: none) and (pointer: coarse)').matches
                  && !!document.documentElement.requestFullscreen;
    let offer = phone;
    let wasPortrait = innerHeight > innerWidth;

    const paint = () => {
      const portrait = innerHeight > innerWidth;
      const wants = !portrait && offer && !document.fullscreenElement;
      el.classList.toggle('nag', portrait);
      el.classList.toggle('full', wants);
      el.classList.toggle('hidden', !portrait && !wants);
    };

    const turned = () => {
      // A fresh rotation re-arms the offer and takes the free shot.
      offer = phone;
      if (offer && innerHeight <= innerWidth && !document.fullscreenElement) {
        this.goFullscreen();
      }
      paint();
    };

    addEventListener('resize', () => {
      // Entering or leaving fullscreen also fires resize. Only a real flip
      // between portrait and landscape counts as turning the phone, or
      // dismissing the panel would immediately re-arm it.
      const portrait = innerHeight > innerWidth;
      if (portrait !== wasPortrait) { wasPortrait = portrait; turned(); }
      else paint();
    });
    addEventListener('orientationchange', turned);
    document.addEventListener('fullscreenchange', () => {
      // Leaving fullscreen is a decision, not an accident: do not ask again
      // until the phone is turned.
      if (!document.fullscreenElement) offer = false;
      paint();
    });
    el.addEventListener('click', () => this.goFullscreen());
    turned();
  }

  // ------------------------------------------------------------------- menu

  buildMenu() {
    dom('btn-start').onclick = () => this.startRace();
    dom('btn-two').onclick = () => this.showTwoPlayer();
    dom('btn-museum').onclick = () => this.openMuseum();
    dom('btn-options').onclick = () => this.showOptions();
    dom('btn-back').onclick = () => {
      Settings.save(this.settings);
      dom('options').classList.add('hidden');
      dom('menu').classList.remove('hidden');
      this.setIdleCar(this.settings.car);
    };
    dom('btn-menu').onclick = () => this.toMenu();
    // RACE AGAIN is single-player only: restarting a two-player race needs
    // both phones to agree, and a button that silently drops the other person
    // is worse than one that is not there.
    dom('btn-again').onclick = () => { this.endNet(); this.startRace(); };
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

    this.buildTwoPlayer();
    this.buildCarPicker();
    this.buildTrackPicker();
    this.buildToggles();
    this.setIdleCar(this.settings.car);
  }

  buildCarPicker() {
    const wrap = dom('car-picker');
    wrap.innerHTML = '';
    for (const spec of this.racerSpecs) {
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

    group(dom('opt-physics'), Object.keys(PHYSICS), () => this.settings.physics,
      (v) => PHYSICS[v].label, (v) => {
        this.settings.physics = v;
        this.showPhysicsBlurb();
        // The model is baked into every Car when the race is built, so a
        // change mid-race can only take effect on a restart - same as the
        // circuit.
        if (this.paused) this.requireRestart();
      });
    this.showPhysicsBlurb();

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

  showPhysicsBlurb() {
    dom('physics-blurb').textContent = (PHYSICS[this.settings.physics] || PHYSICS.arcade).blurb;
  }

  // ------------------------------------------------------------ two players

  /**
   * Which transport to use.
   *
   * `?net=loopback` swaps WebRTC for a BroadcastChannel between two tabs, so
   * the whole multiplayer path - menus, connection, race, render - can be
   * tested on one machine without depending on somebody else's free broker
   * being up. See tools/check_twoplayer.mjs.
   */
  netModule() {
    const mode = new URLSearchParams(location.search).get('net');
    return mode === 'loopback' ? import('./net/loopback.js') : import('./net/peer.js');
  }

  buildTwoPlayer() {
    const show = (which) => {
      dom('two-pick').classList.toggle('hidden', which !== null);
      dom('two-host').classList.toggle('hidden', which !== 'host');
      dom('two-join').classList.toggle('hidden', which !== 'join');
    };

    dom('btn-two-back').onclick = () => {
      this.net?.session?.cancel?.();
      this.net = null;
      dom('two').classList.add('hidden');
      dom('menu').classList.remove('hidden');
    };
    dom('btn-host').onclick = () => { show('host'); this.hostRace(); };
    dom('btn-join').onclick = () => show('join');
    dom('btn-connect').onclick = () => this.joinRace(dom('join-code').value.trim().toUpperCase());
    dom('join-code').oninput = (e) => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    };

    // Each player's own level of help. The AI's difficulty is the host's, but
    // how much the car drives itself is personal - which is the whole point
    // when a parent and a five-year-old share a grid.
    const el = dom('opt-help');
    const labels = { easy: 'Lots', normal: 'Some', hard: 'None' };
    el.innerHTML = '';
    for (const key of Object.keys(DIFFICULTY)) {
      const b = document.createElement('button');
      b.className = 'pill';
      b.textContent = labels[key] || DIFFICULTY[key].label;
      b.classList.toggle('sel', key === (this.settings.help || 'easy'));
      b.onclick = () => {
        this.settings.help = key;
        Settings.save(this.settings);
        for (const c of el.children) c.classList.remove('sel');
        b.classList.add('sel');
      };
      el.appendChild(b);
    }
  }

  showTwoPlayer() {
    dom('menu').classList.add('hidden');
    dom('two').classList.remove('hidden');
    dom('two-pick').classList.remove('hidden');
    dom('two-host').classList.add('hidden');
    dom('two-join').classList.add('hidden');
    dom('room-code').textContent = '----';
    dom('host-status').textContent = '';
    dom('join-status').textContent = '';
  }

  async hostRace() {
    const status = dom('host-status');
    try {
      const net = await this.netModule();
      const session = await net.host((s) => { status.textContent = `${s}…`; });
      this.net = { role: 'host', session };
      dom('room-code').textContent = session.code;
      status.textContent = 'Waiting for the other player…';

      const link = await session.waitForGuest;
      this.net.link = link;
      status.textContent = 'Connected. Starting…';

      link.onMessage((msg) => {
        if (!this.net) return;
        this.net.lastHeard = performance.now() / 1000;
        if (msg.t === MSG.HELLO) this.beginHosted(link, msg);
        else if (msg.t === MSG.INPUT) this.net.remote?.receive(msg.b, msg.q);
      });
      link.onClose = () => this.guestLeft();
    } catch (err) {
      status.textContent = `${err.message}. Try again, or race on your own.`;
      this.net = null;
    }
  }

  async joinRace(code) {
    const status = dom('join-status');
    if (!code || code.length < 4) { status.textContent = 'Four letters, please.'; return; }
    try {
      const net = await this.netModule();
      status.textContent = 'Connecting…';
      const link = await net.join(code, (s) => { status.textContent = `${s}…`; });
      this.net = { role: 'guest', link };
      status.textContent = 'Connected. Waiting for the host…';

      link.onMessage((msg) => {
        if (!this.net) return;
        this.net.lastHeard = performance.now() / 1000;
        if (msg.t === MSG.START) this.beginJoined(link, msg);
        else if (msg.t === MSG.SNAP) this.net.view?.receive(msg, performance.now() / 1000);
      });
      link.onClose = () => this.hostLeft();
      link.send({ t: MSG.HELLO, car: this.settings.car, help: this.settings.help || 'easy' });
    } catch (err) {
      status.textContent = `${err.message}.`;
      this.net = null;
    }
  }

  /** Host: the guest has said hello, so pick cars and start everybody. */
  beginHosted(link, hello) {
    const hostCar = this.settings.car;
    // Two people cannot drive the same car. The guest asked for one; if it is
    // taken they get the first that is not.
    let guestCar = hello.car;
    if (guestCar === hostCar || !this.racerSpecs.some((c) => c.id === guestCar)) {
      guestCar = this.racerSpecs.find((c) => c.id !== hostCar).id;
    }
    const start = {
      t: MSG.START,
      track: this.settings.track,
      laps: this.settings.laps,
      physics: this.settings.physics,
      difficulty: this.settings.difficulty,
      quality: this.settings.quality,
      hostCar,
      guestCar,
      guestHelp: hello.help || 'easy',
    };
    link.send(start);
    this.net.start = start;
    this.net.remote = new RemoteInput();
    this.startRace(start);
  }

  /** Guest: the host has sent the grid, so match it and go. */
  async beginJoined(link, start) {
    this.net.start = start;
    if (start.track !== this.settings.track) {
      dom('join-status').textContent = `Loading ${start.track}…`;
      await this.loadTrackById(start.track);
    }
    this.startRace(start);
  }

  guestLeft() {
    if (!this.net || this.net.role !== 'host') return;
    const car = this.race?.humans.find((c) => c.spec.id === this.net.start?.guestCar);
    this.race?.abandon(car);
    this.net.link?.close?.();
    this.net = null;                  // the rest of the race is single-player
  }

  hostLeft() {
    if (!this.net || this.net.role !== 'guest') return;
    this.net = null;
    this.toMenu();
    dom('menu-track').textContent = 'The other player left the race';
  }

  // --------------------------------------------------------------- museum

  /**
   * Gestures for the showroom, on the canvas rather than a control.
   *
   * Written against pointer events for the same reason `Input` is: the whole
   * screen is the exhibit, two fingers have to work at once, and a finger
   * sliding off nothing should not strand a gesture.
   */
  bindMuseumTouch() {
    const el = this.canvas;
    const active = new Map();
    let pinch = 0;

    const spread = () => {
      const [a, b] = [...active.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };

    el.addEventListener('pointerdown', (e) => {
      if (!this.museum?.saved) return;
      el.setPointerCapture?.(e.pointerId);
      active.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (active.size === 2) pinch = spread();
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.museum?.saved || !active.has(e.pointerId)) return;
      const p = active.get(e.pointerId);
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (active.size >= 2) {
        const now = spread();
        if (pinch > 0 && now > 0) this.museum.pinch(now / pinch);
        pinch = now;
      } else {
        this.museum.drag(dx, dy);
      }
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
      el.addEventListener(type, (e) => {
        active.delete(e.pointerId);
        if (active.size < 2) pinch = 0;
      });
    }
    // Desktop, for testing and for anybody on a laptop.
    el.addEventListener('wheel', (e) => {
      if (!this.museum?.saved) return;
      e.preventDefault();
      this.museum.pinch(e.deltaY > 0 ? 0.92 : 1.087);
    }, { passive: false });

    dom('mus-prev').onclick = () => this.museumStep(-1);
    dom('mus-next').onclick = () => this.museumStep(1);
    dom('mus-back').onclick = () => this.closeMuseum();
  }

  openMuseum() {
    cancelAnimationFrame(this.raf);
    this.museum = this.museum || new Museum(this.scene, this.camera);
    if (!this._museumBound) { this.bindMuseumTouch(); this._museumBound = true; }

    for (const [, m] of this.models) m.object.visible = false;
    dom('menu').classList.add('hidden');
    dom('museum').classList.remove('hidden');

    this.museum.open(this.trackScene);
    this.museumAt = Math.max(0, this.carSpecs.findIndex((c) => c.id === this.settings.car));
    this.museumShow();

    let last = performance.now();
    const tick = (now) => {
      if (!this.museum?.saved) return;
      this.raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      this.museum.update(dt);
      // The wheels turn with the car so a parked exhibit is not a still life.
      const car = this.carSpecs[this.museumAt];
      this.models.get(car.id)?.object.userData.wheels?.update(
        { speed: 0, steerAngle: 0, steer: 0, accelLat: 0, accelLong: 0 }, dt);
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(tick);
  }

  museumStep(by) {
    const n = this.carSpecs.length;
    this.museumAt = (this.museumAt + by + n) % n;
    this.museumShow();
  }

  museumShow() {
    const spec = this.carSpecs[this.museumAt];
    const model = this.models.get(spec.id);
    if (!model) return;
    this.museum.show(model.object, model.size);
    dom('mus-title').textContent = spec.name;
    const chip = dom('mus-number');
    chip.textContent = spec.number;
    chip.style.background = spec.colour;
  }

  closeMuseum() {
    cancelAnimationFrame(this.raf);
    this.museum.close();
    dom('museum').classList.add('hidden');
    dom('menu').classList.remove('hidden');
    this.startIdleCamera();
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

  /** Drop any multiplayer session - on quitting, restarting or finishing. */
  endNet() {
    if (!this.net) return;
    this.net.session?.cancel?.();
    this.net.link?.close?.();
    this.net = null;
  }

  toMenu() {
    cancelAnimationFrame(this.raf);
    this.paused = false;
    this.endNet();
    this.race = null;
    this.audio.silenceEngines();
    dom('result').classList.add('hidden');
    dom('options').classList.add('hidden');
    dom('pause-actions').classList.add('hidden');
    dom('btn-back').classList.remove('hidden');
    dom('hud').classList.add('hidden');
    dom('controls').classList.add('hidden');
    dom('two').classList.add('hidden');
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

  /**
   * @param {object} [start] the host's MSG.START in a two-player race. It is
   *   the single source of truth for the grid: both devices must build the
   *   same one, so nothing here may come from local settings.
   */
  async startRace(start = null) {
    cancelAnimationFrame(this.raf);
    this.paused = false;
    dom('two').classList.add('hidden');
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

    // Racers only. The props are placed - and shown - by the pit lane.
    for (const spec of this.racerSpecs) this.models.get(spec.id).object.visible = true;

    const entries = this.racerSpecs.map((spec) => ({
      spec,
      object: this.models.get(spec.id).object,
    }));

    let race;
    if (start) {
      // Everything about the grid comes off the wire, in a fixed order, so the
      // two devices lay out the same cars in the same slots.
      const humans = [start.hostCar, start.guestCar];
      const mine = this.net.role === 'host' ? start.hostCar : start.guestCar;
      race = new Race(this.track, entries, {
        difficulty: start.difficulty, laps: start.laps,
        physics: start.physics, car: mine,
      }, this.trackSpec().gridLanes).build(mine, humans);

      const hostCar = race.humans.find((c) => c.spec.id === start.hostCar);
      const guestCar = race.humans.find((c) => c.spec.id === start.guestCar);
      race.setAssist(hostCar, this.net.role === 'host'
        ? (this.settings.help || 'easy') : (start.hostHelp || 'easy'));
      race.setAssist(guestCar, this.net.role === 'host'
        ? start.guestHelp : (this.settings.help || 'easy'));

      if (this.net.role === 'host') {
        race.inputs.set(guestCar, this.net.remote);
        this.net.sinceSnap = 0;
      } else {
        // The guest runs no AI and no race logic of its own - it predicts its
        // own car and is told about everything else.
        race.driverAidFor = (car, dt) => driverAid(car, car.lift ?? 0, dt, race.field);
        this.net.view = new GuestView(race);
        this.net.sinceInput = 0;
        this.net.seq = 0;
      }
      this.hud.setLaps(start.laps);
    } else {
      race = new Race(this.track, entries, this.settings,
        this.trackSpec().gridLanes).build(this.settings.car);
      this.hud.setLaps(this.settings.laps);
    }
    this.race = race;
    this.buildPits(race);
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
  /**
   * The pit box, Guido and Mack - set up once when a race starts.
   *
   * All generated geometry, the way `models.js` builds a contact shadow and
   * `museum.js` builds its plinth. Nothing is re-exported from a GLB;
   * `optimize.sh` is the most trap-laden part of this repo and is left alone.
   */
  buildPits(race) {
    if (this.pitGroup) { this.scene.remove(this.pitGroup); this.pitGroup = null; }
    this.crew = null;
    this.hud.setTyres(!!race.pits);
    if (!race.pits) return;

    const road = race.pits.road;
    const group = new THREE.Group();
    group.name = 'pit-furniture';
    const st = {};
    const p = new THREE.Vector3();

    // One yellow box per car, laid flat on the pit road. Slightly proud of the
    // surface, like the contact shadows, or it z-fights with the asphalt.
    const paint = new THREE.MeshBasicMaterial({
      color: 0xffd400, transparent: true, opacity: 0.55, depthWrite: false,
    });
    for (const box of road.boxes) {
      road.sample(box.d, st);
      const mark = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 6.4), paint);
      road.position(st, box.n, p);
      mark.position.copy(p);
      mark.position.y += 0.02;
      mark.rotation.set(-Math.PI / 2, 0, -Math.atan2(st.tx, st.tz));
      group.add(mark);
    }
    this.scene.add(group);
    this.pitGroup = group;

    // Guido waits by the player's own box; Mack is parked behind him.
    const mine = road.boxFor(race.player.gridIndex);
    road.sample(mine.d, st);
    road.position(st, mine.n, p);
    const side = this._w.set(st.ox, 0, st.oz).multiplyScalar(Math.sign(mine.n) || -1);
    const guido = this.models.get('guido');
    const mack = this.models.get('mack');
    this.crew = new PitCrew(guido?.object || null, mack?.object || null, guido?.size || null);
    this.crew.place(p, side, Math.atan2(st.tx, st.tz));
  }

  /** Per frame: the crew, and the tyre readout. */
  updatePits(race, player, dt) {
    if (race.pits) {
      // The open entry wins, because it is the one you can act on: "steer left
      // now". `PIT!` only means the tyres have gone, which is worth knowing
      // and is not something you can do anything about until the entrance.
      // Left, because the pits are inboard and these ovals run anticlockwise.
      const call = race.pitOpen(player) ? 'PIT ◀' : player.tyre < 0.3 ? 'PIT!' : null;
      this.hud.setTyre(player.tyre, call);
    }
    if (!this.crew) return;
    // Guido only ever serves the local player's car: it is a thing to watch,
    // and seven forklifts at once is a car park rather than a pit stop.
    const servicing = player.pit === 'service';
    if (servicing && !this.crew.active) {
      const rig = player.model.userData.wheels;
      const corners = rig
        ? rig.wheels.map((w) => player.model.localToWorld(w.centre.clone()))
        : null;
      // The measured size comes with it, because the standoff has to clear the
      // *bodywork*: the wheels sit inside the nose and tail, so a route built
      // from the wheels alone puts him in the bumper.
      this.crew.begin(corners, player.model, this.models.get(player.spec.id)?.size);
    } else if (!servicing && this.crew.active) {
      this.crew.end();
    }
    this.crew.update(dt);
    // He is a car: his own wheels turn while he trundles.
    this.models.get('guido')?.object.userData.wheels?.update(
      { speed: this.crew.active ? 3.2 : 0, steerAngle: 0, steer: 0,
        accelLat: 0, accelLong: 0 }, dt);
  }

  placeCamera(car, blend) {
    // Whichever ribbon the car is on. Anchoring on the circuit while the car
    // is in the pits leaves the camera eighty metres away pointing down an
    // empty straight - the car is simply not in shot.
    //
    // The handover is safe because the two ribbons overlap in space wherever
    // it can happen, so the camera slides along the road rather than cutting.
    const track = car.road;
    const back = 7.6 + Math.min(3.4, car.speed * 0.05);
    const height = 2.5 + Math.min(1.0, car.speed * 0.011);

    this.camN += (car.n - this.camN) * blend;

    const camSt = track.sample(car.s - back, this._camSt);
    const up = track.normal(camSt, this._up, this.camN);
    track.position(camSt, this.camN, this.camPos).addScaledVector(up, height);

    // Aim just past the car so it sits in the lower third of the screen with
    // the road ahead filling the rest.
    const aimSt = track.sample(car.s + 7, this._aimSt);
    track.position(aimSt, this.camN, this.camAim)
      .addScaledVector(track.normal(aimSt, this._w, this.camN), 1.0);

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

    const net = this.net;
    // Silence is the only reliable sign the other phone has gone. A closed tab
    // fires nothing at all, and a phone that goes to sleep mid-race fires it
    // far too late - so both ends watch the clock rather than trusting the
    // transport to tell them.
    if (net && net.lastHeard && now / 1000 - net.lastHeard > DROP_AFTER) {
      if (net.role === 'host') this.guestLeft(); else this.hostLeft();
      return;
    }

    if (!net) {
      race.update(dt, this.input);
    } else if (net.role === 'host') {
      // The host runs the real race and tells the other phone about it.
      race.update(dt, this.input);
      net.sinceSnap += dt;
      if (net.sinceSnap >= 1 / SNAPSHOT_HZ) {
        net.sinceSnap = 0;
        net.link?.send(snapshot(race));
      }
    } else {
      // The guest predicts its own car, is told about everyone else, and sends
      // nothing but which buttons are down.
      net.view.update(dt, this.input, now / 1000);
      net.sinceInput += dt;
      if (net.sinceInput >= 1 / INPUT_HZ) {
        net.sinceInput = 0;
        net.link?.send({ t: MSG.INPUT, b: packButtons(this.input.state), q: net.seq++ });
      }
      // The lights are the host's to run, so mirror whatever the last snapshot
      // said rather than counting down locally. Watch the *state* as well as
      // the count: the fifth bulb lights while the race is still counting
      // down, so keying only on the count means green never arrives and the
      // gantry stays lit over a car doing 210 km/h.
      if (race.lights !== net.lastLights || race.state !== net.lastState) {
        const go = race.state === State.RACING && net.lastState !== State.RACING;
        net.lastLights = race.lights;
        net.lastState = race.state;
        if (race.state === State.COUNTDOWN) {
          this.hud.setLights(Math.min(race.lights, 5), false);
          this.audio.beep(false);
        } else if (go) {
          this.hud.setLights(5, true);
          this.audio.beep(true);
          setTimeout(() => this.hud.hideLights(), 900);
        }
      }
      if (race.player.finished && !net.shown) {
        net.shown = true;
        this.showResult(race.player);
      }
    }

    for (const car of race.field) car.model.userData.wheels?.update(car, dt);

    const player = race.player;
    this.placeCamera(player, 1 - Math.pow(0.0016, dt));
    this.hud.update(player, this.settings.laps);
    this.updatePits(race, player, dt);

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
      // A car in the wall gets a place like everybody else - it is classified,
      // not deleted - but says why it is down there.
      return `<li class="${c === car ? 'me' : ''}">
        <span class="pos">${c.out ? 'OUT' : i + 1}</span>
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
