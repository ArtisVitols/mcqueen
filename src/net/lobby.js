import { MSG, MAX_PLAYERS, lobbyMessage } from '../net.js';

/**
 * The host's lobby: who is in, what they are driving, and what is set.
 *
 * Kept out of `main.js` on purpose. Everything here is arithmetic on a list of
 * players and a settings object, so it can be driven end to end by four fake
 * links in one process (`tools/check_lobby.mjs`) before any of it is on a
 * screen - which is the only way to test "RACE lights up when everybody is
 * green" without three phones.
 *
 * The host owns the state. A guest sends an *intent* and is told the answer:
 * asking for a car somebody else has taken is simply refused, and the refusal
 * arrives as the next lobby broadcast rather than as an error the guest has to
 * handle. That is the same rule that keeps the two ends of a race from
 * disagreeing about a place, applied one screen earlier.
 */
export class Lobby {
  /**
   * @param {object} opts
   * @param {number} opts.room             which slot this room took
   * @param {string[]} opts.cars           every racer id, in menu order
   * @param {object} opts.settings         track, laps, difficulty, physics, help, ai
   * @param {function} opts.onChange       called whenever the state moves
   */
  constructor({ room, cars, settings, onChange = () => {} }) {
    this.room = room;
    this.cars = cars;
    this.settings = { ...settings };
    this.onChange = onChange;
    this.players = [];
    this.seq = 0;
    this.closed = false;
  }

  /** The host itself, always first and always `p1`. */
  seatHost(car) {
    const me = { id: 'p1', car: this.freeCar(car), host: true, ready: true, link: null };
    this.players.push(me);
    this.changed();
    return me;
  }

  get full() {
    return this.players.length >= MAX_PLAYERS;
  }

  /** Everybody but the host has to say they are ready, and there has to be one. */
  get canStart() {
    return this.players.length > 1 && this.players.every((p) => p.host || p.ready);
  }

  /** How many AI the host may ask for without overfilling the grid. */
  get maxAi() {
    return Math.max(0, this.cars.length - this.players.length);
  }

  /**
   * A car nobody else has.
   *
   * Two people cannot drive the same car - one model, one set of wheels, and
   * on track you would not know which was you. A guest asks for what it had in
   * the menu and gets the first free one if that is taken.
   */
  freeCar(want) {
    const taken = new Set(this.players.map((p) => p.car));
    if (want && this.cars.includes(want) && !taken.has(want)) return want;
    return this.cars.find((id) => !taken.has(id)) || this.cars[0];
  }

  /** Somebody knocked. Returns the player, or null if the room is full. */
  add(link, want) {
    if (this.closed || this.full) return null;
    const id = `p${++this.seq + 1}`;
    const player = { id, car: this.freeCar(want), host: false, ready: false, link };
    this.players.push(player);
    this.settings.ai = Math.min(this.settings.ai, this.maxAi);
    this.changed();
    return player;
  }

  remove(id) {
    const before = this.players.length;
    this.players = this.players.filter((p) => p.id !== id);
    if (this.players.length !== before) this.changed();
  }

  /** A guest's message. Returns true if it moved the lobby. */
  receive(id, msg) {
    const player = this.players.find((p) => p.id === id);
    if (!player || player.host) return false;
    if (msg.t === MSG.PICK) {
      const want = this.freeCar(msg.car);
      // Refused rather than swapped: if the car they asked for is taken they
      // keep the one they have, and the broadcast below tells them so.
      if (want !== msg.car) { this.changed(); return true; }
      player.car = want;
      this.changed();
      return true;
    }
    if (msg.t === MSG.READY) {
      player.ready = !!msg.ready;
      this.changed();
      return true;
    }
    return false;
  }

  /** Host-only controls. Anything that changes the grid unreadies everybody. */
  set(key, value) {
    if (this.settings[key] === value) return;
    this.settings[key] = value;
    if (key === 'ai') this.settings.ai = Math.max(0, Math.min(value, this.maxAi));
    // Changing the race under somebody who has already said yes is how you end
    // up on a circuit nobody agreed to. Track and laps are the ones that show,
    // but the rule is simpler if it is all of them.
    for (const p of this.players) if (!p.host) p.ready = false;
    this.changed();
  }

  message() {
    return lobbyMessage(this.room, this.players, this.settings, this.canStart);
  }

  /**
   * The grid, decided once by the host and sent whole.
   *
   * Both ends must lay out the same grid, and with a field that is no longer
   * every car that means the *list* has to travel, not just the settings -
   * otherwise two devices pick two different sets of AI and the race is
   * different on each screen from the lights out.
   */
  startMessage() {
    const humans = this.players.map((p) => ({ id: p.id, car: p.car }));
    const taken = new Set(humans.map((h) => h.car));
    const ai = this.cars.filter((id) => !taken.has(id)).slice(0, this.settings.ai);
    return {
      t: MSG.START,
      room: this.room,
      track: this.settings.track,
      laps: this.settings.laps,
      physics: this.settings.physics,
      difficulty: this.settings.difficulty,
      help: this.settings.help,
      humans,
      field: [...humans.map((h) => h.car), ...ai],
    };
  }

  changed() {
    this.settings.ai = Math.max(0, Math.min(this.settings.ai, this.maxAi));
    this.onChange(this);
  }
}
