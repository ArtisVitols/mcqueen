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
import { Lobby } from './net/lobby.js';
import { Museum } from './museum.js';
import { PitCrew } from './pitcrew.js';
import { Smoke, smokeFor } from './smoke.js';
import { skyTexture } from './sky.js';
import { makeCrowd, swayCrowd } from './crowd.js';

const dom = (id) => document.getElementById(id);

// Seconds of silence before the other phone counts as gone. Long enough to
// ride out a lift tunnel, short enough that nobody races a ghost.
//
// Raised from 5 when the grid went to eighteen cars. Five seconds is fine as
// "this phone has gone" and much too tight as "this phone is having a hard
// time": a device struggling with a full field goes quiet in bursts, and two
// tabs under a software renderer dropped each other mid-race with neither of
// them having gone anywhere. The heartbeat is on a wall clock now (see
// `startPump`) rather than the frame rate, which is the real fix; this is the
// margin that makes it forgiving.
const DROP_AFTER = 12;

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
    this.net = null;              // {role, link/peers, lobby, view, ...} when networked

    this.camPos = new THREE.Vector3();
    this.camAim = new THREE.Vector3();
    // Carried across a change of ribbon - see placeCamera.
    this._camRoad = null;
    this._camWas = new THREE.Vector3();
    this._aimWas = new THREE.Vector3();
    this._camFix = new THREE.Vector3();
    this._aimFix = new THREE.Vector3();
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
    this.watchBack();
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
    // The crowd belongs to the circuit and goes with it: only one track is
    // ever resident, and a stand full of people from the last one would be
    // standing in the infield of this one.
    if (this.crowd) {
      this.scene.remove(this.crowd);
      this.crowd.geometry.dispose();
      this.crowd.material.dispose();
    }
    this.crowd = makeCrowd(track.data);
    if (this.crowd) this.scene.add(this.crowd);
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
    // Clouds rather than a flat blue. Drawn into a canvas once and used as the
    // background, which costs one full-screen pass and nothing per frame - see
    // src/sky.js for why it is not billboards.
    scene.background = skyTexture(7, '#9ecbf0');
    scene.fog = new THREE.Fog(0x9ecbf0, 260, q.fog);
    this.scene = scene;

    // Tyre smoke and a wreck's engine. One pooled Points for the whole race.
    // Low quality halves both the pool and the rate it is filled at: it is the
    // setting for a phone that is already working, and smoke is the first
    // thing that should give way.
    this.smokeQuality = q.shadows ? 1 : 0.5;
    this.smoke = new Smoke(q.shadows ? 320 : 160);
    scene.add(this.smoke.points);

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
    // Point size is in pixels, so the puffs have to follow the buffer.
    this.smoke?.resize(h * this.renderer.getPixelRatio());
    swayCrowd(this.crowd, 0, h * this.renderer.getPixelRatio());
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
    const phone = isPhone();
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
    this.showTwo = show;

    dom('btn-two-back').onclick = () => {
      this.endNet();
      dom('two').classList.add('hidden');
      dom('menu').classList.remove('hidden');
    };
    dom('btn-host').onclick = () => { show('host'); this.hostRace(); };
    dom('btn-join').onclick = () => { show('join'); this.findRooms(); };
    dom('btn-refresh').onclick = () => this.findRooms();
    this.buildLobbyScreen();
  }

  showTwoPlayer() {
    dom('menu').classList.add('hidden');
    dom('two').classList.remove('hidden');
    this.showTwo(null);
    dom('host-status').textContent = '';
    dom('join-status').textContent = '';
    dom('room-list').innerHTML = '';
  }

  // ------------------------------------------------------------------ lobby

  /**
   * Open a room and hold it, taking everybody who knocks.
   *
   * The race no longer starts when somebody connects - that was the whole of
   * two-player multiplayer, and it left nowhere to choose a car or agree on a
   * circuit. What a connection does now is fill a seat in the lobby.
   */
  async hostRace() {
    const status = dom('host-status');
    try {
      const net = await this.netModule();
      const session = await net.host((s) => { status.textContent = `${s}…`; });
      this.net = { role: 'host', session, peers: new Map() };
      const lobby = new Lobby({
        room: session.room,
        cars: this.racerSpecs.map((c) => c.id),
        settings: {
          track: this.settings.track,
          laps: this.settings.laps,
          difficulty: this.settings.difficulty,
          physics: this.settings.physics,
          // **None by default when people race each other.** `help` is the
          // driver aid on a *human's* car, and on Easy it steers, brakes and
          // overtakes for you - which is right for a five-year-old racing the
          // AI and reads as "my car is driving itself" when two people are
          // racing. The host can still turn it up for a race against a child;
          // it is just no longer what you get without asking.
          help: 'hard',
          ai: this.racerSpecs.length - 1,
        },
        onChange: () => this.pushLobby(),
      });
      this.net.lobby = lobby;
      lobby.seatHost(this.settings.car);
      this.net.me = 'p1';
      session.onGuest((link) => this.guestArrived(link));
      this.showLobby();
    } catch (err) {
      status.textContent = `${err.message}. Try again, or race on your own.`;
      this.endNet();
    }
  }

  /** Host: somebody knocked. Seat them, or turn them away. */
  guestArrived(link) {
    const lobby = this.net?.lobby;
    if (!lobby) { link.close?.(); return; }
    // Greet every connection with the lobby *before* deciding whether to seat
    // it: a guest that is only looking uses exactly this message as the advert
    // in its list, and then closes. See `list` in net/peer.js.
    link.send(lobby.message());
    let player = null;
    link.onMessage((msg) => {
      if (!this.net?.lobby) return;
      const peer = player && this.net.peers.get(player.id);
      if (peer) peer.lastHeard = performance.now() / 1000;
      if (msg.t === MSG.JOIN && !player) {
        player = lobby.add(link, msg.car);
        if (!player) { link.send({ t: MSG.BYE, why: 'full' }); link.close?.(); return; }
        this.net.peers.set(player.id, {
          link, input: new RemoteInput(), lastHeard: performance.now() / 1000,
        });
        link.send({ ...lobby.message(), you: player.id });
        this.pushLobby();
      } else if (msg.t === MSG.INPUT && player) {
        this.net.peers.get(player.id)?.input.receive(msg.b, msg.q);
      } else if (player) {
        lobby.receive(player.id, msg);
      }
    });
    link.onClose = () => { if (player) this.playerLeft(player.id); };
  }

  /** Send the lobby to everybody, and redraw it here. */
  pushLobby() {
    const lobby = this.net?.lobby;
    if (!lobby) return;
    const msg = lobby.message();
    for (const [id, peer] of this.net.peers) peer.link.send({ ...msg, you: id });
    this.net.state = msg;
    this.drawLobby();
  }

  /** Knock on every room and show whoever answers. */
  async findRooms() {
    const status = dom('join-status');
    const list = dom('room-list');
    list.innerHTML = '';
    status.textContent = 'Looking for games…';
    try {
      const net = await this.netModule();
      let found = 0;
      const close = await net.list(({ room, link, hello }) => {
        found++;
        list.appendChild(this.roomRow(room, hello, () => {
          this.net.closeProbes?.(room);
          this.joinRoom(link);
        }));
      }, () => {});
      this.net = { role: 'guest', closeProbes: close };
      status.textContent = found
        ? `${found} game${found > 1 ? 's' : ''} - tap one to join`
        : 'No games found. Ask them to press HOST A RACE, then look again.';
    } catch (err) {
      status.textContent = `${err.message}.`;
      this.endNet();
    }
  }

  /** One line in the found-games list. */
  roomRow(room, hello, onPick) {
    const b = document.createElement('button');
    b.className = 'room';
    const players = hello?.players?.length || 1;
    const hostCar = this.racerSpecs.find((c) => c.id === hello?.players?.[0]?.car);
    b.innerHTML = `<span class="rname">Room ${room}</span>
      ${hostCar ? `<span class="chip" style="background:${hostCar.colour}">${hostCar.number}</span>
                   <span class="cname">${hostCar.name}</span>` : ''}
      <span class="rwho">${players} player${players > 1 ? 's' : ''}</span>`;
    b.onclick = onPick;
    return b;
  }

  /** Guest: take the seat on a link the probe already opened. */
  joinRoom(link) {
    this.net = { role: 'guest', link };
    link.onMessage((msg) => {
      if (!this.net) return;
      this.net.lastHeard = performance.now() / 1000;
      if (msg.t === MSG.LOBBY) {
        if (msg.you) this.net.me = msg.you;
        this.net.state = msg;
        this.showLobby();
      } else if (msg.t === MSG.START) this.beginJoined(msg);
      else if (msg.t === MSG.SNAP) this.net.view?.receive(msg, performance.now() / 1000);
      else if (msg.t === MSG.BYE) {
        dom('join-status').textContent = 'That game is full.';
        this.endNet();
        this.showTwoPlayer();
      }
    });
    link.onClose = () => this.hostLeft();
    link.send({ t: MSG.JOIN, car: this.settings.car });
  }

  /** Guest: the host has sent the grid, so match it and go. */
  async beginJoined(start) {
    this.net.start = start;
    if (start.track !== this.settings.track) {
      dom('lobby-hint').textContent = 'Loading the circuit…';
      await this.loadTrackById(start.track);
    }
    this.startRace(start);
  }

  /** Host: a seat emptied. In the lobby they vanish; in a race an AI takes over. */
  playerLeft(id) {
    if (!this.net || this.net.role !== 'host') return;
    const peer = this.net.peers.get(id);
    peer?.link?.close?.();
    this.net.peers.delete(id);
    const seat = this.net.lobby?.players.find((p) => p.id === id);
    if (this.race && seat) {
      const car = this.race.humans.find((c) => c.spec.id === seat.car);
      this.race.abandon(car);
    }
    this.net.lobby?.remove(id);
    if (!this.race && this.net.peers.size === 0) this.drawLobby();
  }

  hostLeft() {
    if (!this.net || this.net.role !== 'guest') return;
    this.stopPump();
    this.endNet();
    if (this.race) {
      this.toMenu();
      dom('menu-track').textContent = 'The host left the race';
    } else {
      dom('lobby').classList.add('hidden');
      this.showTwoPlayer();
      dom('join-status').textContent = 'The host closed the room.';
    }
  }

  /**
   * Wire the lobby once. It is the same screen for everybody.
   *
   * The host's controls are simply hidden from a guest rather than built
   * differently, because both ends draw the same state and the difference is
   * only who is allowed to change it - which is decided on the host anyway.
   */
  buildLobbyScreen() {
    dom('btn-leave').onclick = () => {
      this.endNet();
      dom('lobby').classList.add('hidden');
      this.showTwoPlayer();
    };
    dom('btn-ready').onclick = () => {
      const me = this.net?.state?.players.find((p) => p.id === this.net.me);
      this.net?.link?.send({ t: MSG.READY, ready: !me?.ready });
    };
    dom('btn-race').onclick = () => this.hostStartRace();

    const lobby = () => this.net?.lobby;
    this.pillGroup(dom('lobby-laps'), LAP_CHOICES, (v) => `${v}`,
      () => lobby()?.settings.laps, (v) => lobby()?.set('laps', v));
    this.pillGroup(dom('lobby-difficulty'), Object.keys(DIFFICULTY),
      (v) => DIFFICULTY[v].label,
      () => lobby()?.settings.difficulty, (v) => lobby()?.set('difficulty', v));
    this.pillGroup(dom('lobby-physics'), Object.keys(PHYSICS), (v) => PHYSICS[v].label,
      () => lobby()?.settings.physics, (v) => lobby()?.set('physics', v));
    // How much the car drives itself. One level for the whole grid: the host's.
    const help = { easy: 'Lots', normal: 'Some', hard: 'None' };
    this.pillGroup(dom('lobby-help'), Object.keys(DIFFICULTY), (v) => help[v],
      () => lobby()?.settings.help, (v) => lobby()?.set('help', v));
  }

  /**
   * A row of pills that reads its selection from a getter.
   *
   * The options screen builds its rows the same way (`buildToggles`); this is
   * that helper lifted out so the lobby can use it rather than growing a
   * second copy that drifts.
   */
  pillGroup(el, values, label, current, onPick) {
    el.innerHTML = '';
    for (const v of values) {
      const b = document.createElement('button');
      b.className = 'pill';
      b.dataset.value = v;
      b.textContent = label(v);
      b.onclick = () => onPick(v);
      el.appendChild(b);
    }
    el.dataset.bound = '1';
    this._pillRows = this._pillRows || [];
    this._pillRows.push({ el, current });
  }

  showLobby() {
    dom('two').classList.add('hidden');
    dom('menu').classList.add('hidden');
    dom('lobby').classList.remove('hidden');
    this.drawLobby();
  }

  /** Draw whatever the lobby state says - ours if we host it, the host's if not. */
  drawLobby() {
    const state = this.net?.role === 'host' ? this.net.lobby?.message() : this.net?.state;
    if (!state) return;
    if (this.net.role === 'host') this.net.state = state;
    const host = this.net.role === 'host';
    const me = this.net.me;
    dom('lobby-room').textContent = state.room;

    dom('lobby-players').innerHTML = state.players.map((p) => {
      const spec = this.racerSpecs.find((c) => c.id === p.car);
      return `<li class="${p.id === me ? 'me' : ''}">
        <span class="chip" style="background:${spec?.colour || '#666'}">${spec?.number || '?'}</span>
        <span class="pwho">${spec?.name || p.car}</span>
        <span class="ptag">${p.host ? 'HOST' : ''}${p.id === me ? ' YOU' : ''}</span>
        <span class="${p.ready ? 'pready' : 'pwait'}">${p.ready ? '✓' : '…'}</span></li>`;
    }).join('');

    // Cars somebody else has are shown but cannot be taken.
    const taken = new Set(state.players.filter((p) => p.id !== me).map((p) => p.car));
    const mine = state.players.find((p) => p.id === me)?.car;
    dom('lobby-cars').innerHTML = '';
    for (const spec of this.racerSpecs) {
      const b = document.createElement('button');
      b.className = 'card';
      b.dataset.car = spec.id;
      b.disabled = taken.has(spec.id);
      b.classList.toggle('sel', spec.id === mine);
      b.innerHTML = `<span class="chip" style="background:${spec.colour}">${spec.number}</span>
                     <span class="cname">${spec.name}</span>`;
      b.onclick = () => this.pickLobbyCar(spec.id);
      dom('lobby-cars').appendChild(b);
    }

    dom('lobby-host').classList.toggle('hidden', !host);
    dom('btn-ready').classList.toggle('hidden', host);
    dom('btn-race').classList.toggle('hidden', !host);
    if (host) {
      this.syncLobbyTrack(state.settings.track);
      this.syncAiPills();
      for (const row of this._pillRows || []) {
        const now = row.current();
        for (const b of row.el.children) b.classList.toggle('sel', b.dataset.value == now);
      }
      dom('btn-race').disabled = !state.canStart;
      dom('lobby-hint').textContent = state.canStart
        ? 'Everybody is ready.'
        : state.players.length < 2 ? 'Waiting for somebody to join…'
                                   : 'Waiting for everybody to press READY…';
    } else {
      const ready = state.players.find((p) => p.id === me)?.ready;
      dom('btn-ready').textContent = ready ? 'READY ✓' : 'READY';
      dom('btn-ready').classList.toggle('on', !!ready);
      dom('lobby-hint').textContent = ready ? 'Waiting for the host to start…'
                                            : 'Pick a car, then press READY.';
    }
  }

  pickLobbyCar(id) {
    if (this.net?.role === 'host') {
      const seat = this.net.lobby.players.find((p) => p.host);
      const free = this.net.lobby.freeCar(id);
      if (free !== id) return;              // somebody else has it
      seat.car = id;
      this.settings.car = id;
      Settings.save(this.settings);
      this.net.lobby.changed();
    } else {
      this.net?.link?.send({ t: MSG.PICK, car: id });
    }
  }

  /** The host's circuit and AI-count rows, which depend on state to build. */
  syncLobbyTrack(current) {
    const wrap = dom('lobby-track');
    if (!wrap.children.length) {
      for (const spec of this.trackSpecs) {
        const b = document.createElement('button');
        b.className = 'card track';
        b.dataset.track = spec.id;
        b.innerHTML = `<span class="tname">${spec.short}</span>`;
        b.onclick = () => this.net?.lobby?.set('track', spec.id);
        wrap.appendChild(b);
      }
    }
    for (const b of wrap.children) b.classList.toggle('sel', b.dataset.track === current);
  }

  /**
   * How many AI to fill the grid with.
   *
   * The choices depend on how many people are in - the field can never be
   * more cars than there are pit boxes - so this row is rebuilt rather than
   * just re-selected.
   */
  syncAiPills() {
    const lobby = this.net.lobby;
    const max = lobby.maxAi;
    const choices = [0, 2, 4, 6, 10, max].filter((v, i, a) => v <= max && a.indexOf(v) === i);
    const el = dom('lobby-ai');
    el.innerHTML = '';
    for (const v of choices) {
      const b = document.createElement('button');
      b.className = 'pill';
      b.textContent = `${v}`;
      b.classList.toggle('sel', v === lobby.settings.ai);
      b.onclick = () => lobby.set('ai', v);
      el.appendChild(b);
    }
  }

  /** Host: everybody is green, so send the grid and go. */
  hostStartRace() {
    const lobby = this.net?.lobby;
    if (!lobby?.canStart) return;
    const start = lobby.startMessage();
    for (const [, peer] of this.net.peers) peer.link.send(start);
    this.net.start = start;
    dom('lobby').classList.add('hidden');
    if (start.track !== this.settings.track) {
      this.loadTrackById(start.track).then(() => this.startRace(start));
    } else {
      this.startRace(start);
    }
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
    // Take the screen back. Leaving landscape drops the fullscreen offer until
    // the phone is turned again (see `watchOrientation`), so without this a
    // player who used Back and then carried on racing would spend the rest of
    // the race behind the browser's chrome with no way to ask for the screen.
    // This one is a tap, so unlike a rotation it is allowed to succeed.
    if (isPhone()) this.goFullscreen();
    this.closePauseOverlay();
    dom('hud').classList.remove('hidden');
    dom('controls').classList.remove('hidden');
    // Laps or difficulty may have changed; apply what can be applied live.
    //
    // Not in a networked race, where every one of these belongs to the host:
    // a guest that paused and resumed would quietly re-cut the race to its own
    // local lap count while the other phone raced the agreed one.
    if (!this.net) {
      this.race.totalLaps = this.settings.laps;
      for (const car of this.race.field) car.totalLaps = this.settings.laps;
    }
    this.hud.setLaps(this.race.totalLaps);
    this.audio.setEnabled(this.settings.sound);
    this.audio.setVolume(this.settings.volume);
    this._last = performance.now();
    this.loop(this._last);
  }

  /**
   * Keep the two phones talking on a **wall clock**, not on frames.
   *
   * Both ends decide the other has gone by hearing nothing for `DROP_AFTER`
   * seconds, and that is the right test - a closed tab fires no event and a
   * sleeping phone fires one far too late. But it only works if a device that
   * is merely *slow* still says something. Sending from the render loop ties
   * the heartbeat to the frame rate, so a phone struggling with a full grid
   * looks exactly like a phone that has been switched off: with eighteen cars
   * on screen, two tabs under a software renderer each dropped the other
   * mid-race, and neither of them had gone anywhere.
   *
   * The interval keeps running when frames do not, so being slow now costs
   * smoothness and nothing else.
   */
  startPump() {
    this.stopPump();
    const net = this.net;
    if (!net) return;
    // **Start everyone's silence clock now.**
    //
    // `lastHeard` was last set when that guest clicked READY, and a guest says
    // nothing at all between there and its own first input packet - which it
    // cannot send until it has built the race and, on a circuit it did not
    // already have, downloaded and parsed it. On a phone that is easily longer
    // than `DROP_AFTER`, so the host evicted both players the instant the pump
    // started and handed their cars to the AI before the lights went out. The
    // timeout is meant to notice a phone that has *gone*, and it should start
    // counting from when we start listening.
    const begun = performance.now() / 1000;
    if (net.peers) for (const peer of net.peers.values()) peer.lastHeard = begun;
    net.lastHeard = begun;
    const hz = net.role === 'host' ? SNAPSHOT_HZ : INPUT_HZ;
    net.pump = setInterval(() => {
      if (this.net !== net || !this.race) return;
      // Noticing that a phone has gone belongs on this clock too. In the render
      // loop it was as late as the frame rate, which on the device most likely
      // to lose its connection is the frame rate least able to say so.
      const now = performance.now() / 1000;
      if (net.role === 'host') {
        const snap = snapshot(this.race);
        for (const [id, peer] of [...net.peers]) {
          if (now - peer.lastHeard > DROP_AFTER) { this.playerLeft(id); continue; }
          peer.link.send(snap);
        }
      } else {
        if (net.lastHeard && now - net.lastHeard > DROP_AFTER) { this.hostLeft(); return; }
        net.link?.send({ t: MSG.INPUT, b: packButtons(this.input.state), q: net.seq++ });
      }
    }, 1000 / hz);
  }

  stopPump() {
    if (this.net?.pump) clearInterval(this.net.pump);
    if (this.net) this.net.pump = 0;
  }

  /** Drop any multiplayer session - on quitting, restarting or finishing. */
  endNet() {
    if (!this.net) return;
    this.stopPump();
    this.net.session?.cancel?.();
    this.net.closeProbes?.();
    for (const [, peer] of this.net.peers || []) peer.link?.close?.();
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
    // The lobby closes *here*, not in whoever decided to start.
    //
    // `hostStartRace` hid it on the way past, so the host never saw a problem;
    // a guest arrives through `beginJoined` and nothing had ever closed it, so
    // it raced the whole way with the lobby sitting over the screen. Anything
    // that has to be true of every race belongs in the one function every
    // route goes through. The host's own early hide stays, because it answers
    // the tap before the circuit has finished loading.
    dom('lobby').classList.add('hidden');
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

    // The field. In a race off the wire it is exactly the list the host sent -
    // people first, then however many AI were asked for - because with a grid
    // that is no longer *every* car, "both devices lay out the same grid" needs
    // the list to travel and not just the settings.
    const fieldIds = start ? start.field : this.racerSpecs.map((c) => c.id);
    for (const spec of this.racerSpecs) {
      this.models.get(spec.id).object.visible = fieldIds.includes(spec.id);
    }
    const entries = fieldIds.map((id) => ({
      spec: this.racerSpecs.find((c) => c.id === id),
      object: this.models.get(id).object,
    }));

    let race;
    if (start) {
      const humans = start.humans.map((h) => h.car);
      const seat = start.humans.find((h) => h.id === this.net.me) || start.humans[0];
      const mine = seat.car;
      race = new Race(this.track, entries, {
        difficulty: start.difficulty, laps: start.laps,
        physics: start.physics, car: mine,
      }, this.trackSpec().gridLanes).build(mine, humans);

      // One level of help for the whole grid, the host's - it travels in the
      // start message like everything else about the race.
      for (const car of race.humans) race.setAssist(car, start.help || 'hard');

      if (this.net.role === 'host') {
        // Every remote player's buttons arrive on their own link and are
        // applied where a local player's would be.
        for (const [id, peer] of this.net.peers) {
          const car = race.humans.find((c) => c.spec.id ===
            start.humans.find((h) => h.id === id)?.car);
          if (car) race.inputs.set(car, peer.input);
        }
      } else {
        // A guest runs no AI and no race logic of its own - it predicts its
        // own car and is told about everything else.
        race.driverAidFor = (car, dt) => driverAid(car, car.lift ?? 0, dt, race.field);
        this.net.view = new GuestView(race);
        this.net.seq = 0;
      }
      this.hud.setLaps(start.laps);
      this.startPump();
    } else {
      race = new Race(this.track, entries, this.settings,
        this.trackSpec().gridLanes).build(this.settings.car);
      this.hud.setLaps(this.settings.laps);
    }
    this.race = race;
    this.buildPits(race);
    this.hud.setField(race.field.length);
    this.hud.setLights(0, false);
    // `race.totalLaps`, never `settings.laps`. In a race off the wire the lap
    // count is the host's, and `hud.update` *clamps* the number it shows to
    // the total it is handed - so a guest whose own OPTIONS said 5 while the
    // host chose 10 watched its lap counter stop at 5 and stay there.
    this.hud.update(race.player, race.totalLaps);

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

    // Changing ribbon moves the *camera*, even when it does not move the car.
    //
    // The anchor is `car.s - back`, and eight metres behind a car sitting at
    // the mouth of the pit lane is a completely different place on the two
    // roads - 12 m apart turning in, 6 m coming out, in one frame. `car.n`
    // changes meaning at the same instant. The car crosses cleanly and the
    // view snaps, which is exactly what it looks like from the cockpit.
    //
    // So carry the discontinuity as an offset and let it decay: the camera
    // keeps its old position on the frame of the handover and slides onto the
    // new anchor over the next fraction of a second. `blend` is already the
    // frame-rate-independent smoothing this camera uses for lane changes, so
    // the fade costs nothing new and is stable at any frame rate.
    const changed = this._camRoad !== track;
    this._camRoad = track;
    if (changed) {
      this._camWas.copy(this.camPos);
      this._aimWas.copy(this.camAim);
      this.camN = car.n;           // it is an offset from a different centreline
    }

    this.camN += (car.n - this.camN) * blend;

    const camSt = track.sample(car.s - back, this._camSt);
    const up = track.normal(camSt, this._up, this.camN);
    track.position(camSt, this.camN, this.camPos).addScaledVector(up, height);

    // Aim just past the car so it sits in the lower third of the screen with
    // the road ahead filling the rest.
    const aimSt = track.sample(car.s + 7, this._aimSt);
    track.position(aimSt, this.camN, this.camAim)
      .addScaledVector(track.normal(aimSt, this._w, this.camN), 1.0);

    if (changed) {
      this._camFix.copy(this._camWas).sub(this.camPos);
      this._aimFix.copy(this._aimWas).sub(this.camAim);
    }
    this.camPos.add(this._camFix);
    this.camAim.add(this._aimFix);
    // Decayed *after* being applied, so the handover frame itself moves the
    // camera by nothing at all rather than by a tenth of the jump.
    this._camFix.multiplyScalar(1 - blend);
    this._aimFix.multiplyScalar(1 - blend);

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
    // Silence is the only reliable sign the other phone has gone - a closed tab
    // fires nothing at all and a sleeping phone fires far too late - and that
    // watch is kept by `startPump`, on a wall clock, along with the heartbeat
    // itself.
    if (!net) {
      race.update(dt, this.input);
    } else if (net.role === 'host') {
      // The host runs the real race and tells the other phone about it.
      race.update(dt, this.input);
      // The snapshot goes out on `startPump`'s clock, not this one.
    } else {
      // The guest predicts its own car, is told about everyone else, and sends
      // nothing but which buttons are down.
      net.view.update(dt, this.input, now / 1000);
      // Buttons go out on `startPump`'s clock, not this one.
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

    for (const car of race.field) {
      car.model.userData.wheels?.update(car, dt);
      // Smoke is drawn from state every car already carries - `slip` is the
      // same number the tyre squeal is mixed from, and `out` is on the wire -
      // so a guest sees a rival's slide and a rival's wreck without anything
      // extra being sent.
      smokeFor(this.smoke, car, dt, this.smokeQuality);
    }
    this.smoke.update(dt);
    swayCrowd(this.crowd, this.smoke.time);

    const player = race.player;
    this.placeCamera(player, 1 - Math.pow(0.0016, dt));
    this.hud.update(player, this.race.totalLaps);
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
    dom('result-order').innerHTML = this.race.order.map((c, i) => {
      const spec = c.spec;
      // A car in the wall gets a place like everybody else - it is classified,
      // not deleted - but says why it is down there.
      return `<li class="${c === car ? 'me' : ''}">
        <span class="pos">${c.out ? 'OUT' : i + 1}</span>
        <span class="chip" style="background:${spec.colour}">${spec.number}</span>
        <span class="cname">${spec.name}</span></li>`;
    }).join('');
    dom('result').classList.remove('hidden');
    // Eighteen finishers do not fit, so put the player's own line in view.
    // Being told you came 17th and having to hunt for yourself is not a
    // result screen, it is a puzzle.
    dom('result-order').querySelector('.me')
      ?.scrollIntoView({ block: 'center' });
  }

  goFullscreen() {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    }
    // Android honours this; iOS ignores it, hence the rotate overlay.
    screen.orientation?.lock?.('landscape').catch(() => {});
    this.guardBack();
  }

  /**
   * Make the phone's Back button a way out of landscape.
   *
   * Holding the screen means two things on Android - fullscreen, and an
   * orientation lock - and a player who wants their phone back has to fight
   * both. Back is the button they will reach for, and by default it either
   * does nothing useful or leaves the site altogether, which throws away the
   * race.
   *
   * A history entry is the standard way to borrow it: push one on the way into
   * fullscreen, and the gesture pops that instead of navigating. There is
   * nothing else to go back *to* in a single-page game, so the entry can only
   * ever mean "let go of the screen".
   */
  guardBack() {
    // Phones only, and for the same reason the rotate overlay is: there is no
    // Back button on a desktop, and every browser test runs there. Borrowing
    // history entries in a page that is being driven by a test is a good way
    // to have one of them navigate away mid-race.
    if (this.backGuard || !isPhone()) return;
    this.backGuard = true;
    history.pushState({ mcqueen: 'fullscreen' }, '');
  }

  /** Hand the phone back: no fullscreen, no orientation lock, race paused. */
  dropFullscreen() {
    screen.orientation?.unlock?.();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    // A race left running is a car driving into a wall while its driver is
    // reading a message. The pause menu is already the "I need a moment"
    // screen, so use it rather than inventing another.
    this.pauseRace();
  }

  /**
   * Keep the borrowed history entry in step with the screen.
   *
   * If fullscreen ends some other way - Escape, the browser's own gesture, the
   * system - the entry we pushed is still sitting on the stack, and the next
   * Back would be swallowed doing nothing. Spend it ourselves, but only when
   * it is genuinely ours to spend: `history.state` says whether the entry on
   * top is the one this pushed.
   */
  watchBack() {
    addEventListener('popstate', () => {
      // Unconditionally, even with no fullscreen to leave. iOS never grants it
      // and refuses the orientation lock too, so there the entry was pushed
      // for a screen that was never taken - and a borrowed Back that does
      // nothing at all is worse than one that pauses.
      this.backGuard = false;
      this.dropFullscreen();
    });
    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement || !this.backGuard) return;
      this.backGuard = false;
      if (history.state?.mcqueen === 'fullscreen') history.back();
    });
  }
}

/**
 * A phone, as far as this game is concerned: a touch screen that can go
 * fullscreen. Headless Chrome is neither, which is what keeps the rotate
 * overlay and the Back-button guard out of every browser test.
 */
function isPhone() {
  return matchMedia('(hover: none) and (pointer: coarse)').matches
         && !!document.documentElement.requestFullscreen;
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
