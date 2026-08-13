/**
 * Does JOIN actually find a hosted room?
 *
 * **This is the one path no other test covers.** `check_lobby` drives fake
 * links and `check_twoplayer` drives loopback between tabs; both start *after*
 * a connection exists. Everything in `net/peer.js` - taking a room slot,
 * knocking on all eight, telling "free" apart from "broken" - only ever ran on
 * real phones, and it was broken on them for a release.
 *
 * What broke: `openPeer` binds an `error` handler that destroys the peer, and
 * never unbinds it once the peer is open. PeerJS emits `peer-unavailable`
 * through `emitError`, which is a *routine* notification - a free slot answers
 * with exactly that. So a guest probing eight rooms got seven of them back as
 * `peer-unavailable`, and the first one destroyed the peer doing the probing,
 * killing the connection to the room that *was* live. The broker answers
 * "nobody there" far faster than a real host completes an ICE handshake, so the
 * destroy always won: **no games found, every time.**
 *
 * A broker cannot be reached from here, so PeerJS is faked - closely enough to
 * matter: errors land on the *peer* (not the connection), `peer-unavailable`
 * is non-fatal, and a live room answers slower than a dead one.
 *
 *   node tools/check_rooms.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const fail = (m) => { console.log('  FAIL:', m); failed++; };
const ok = (m) => console.log('  ok:', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----------------------------------------------------------------- fake --

/** eventemitter3 is what PeerJS uses; `off` is an alias of removeListener. */
class Emitter {
  constructor() { this._h = new Map(); }
  on(ev, fn) {
    if (!this._h.has(ev)) this._h.set(ev, []);
    this._h.get(ev).push(fn);
    return this;
  }
  off(ev, fn) {
    const l = this._h.get(ev);
    if (l) this._h.set(ev, l.filter((f) => f !== fn));
    return this;
  }
  emit(ev, arg) { for (const fn of [...(this._h.get(ev) || [])]) fn(arg); }
  get listenerCount() {
    let n = 0;
    for (const l of this._h.values()) n += l.length;
    return n;
  }
}

/** The broker: which ids are currently held. */
const held = new Map();

class FakeConn extends Emitter {
  constructor(peer, target) {
    super();
    this.peer = target;          // PeerJS names the *remote* id `conn.peer`
    this.open = false;
    this.owner = peer;
    this.closed = false;
  }
  send(msg) { this.remote?.emit('data', msg); }
  close() { this.closed = true; this.open = false; this.emit('close'); }
}

class FakePeer extends Emitter {
  /** @param {string|undefined} id  undefined means "give me one" */
  constructor(id, opts = {}) {
    super();
    this.destroyed = false;
    this.conns = [];
    this._id = id;
    // The broker answers asynchronously, as a real one does.
    setTimeout(() => {
      if (this.destroyed) return;
      if (id !== undefined && held.has(id)) {
        // Same shape PeerJS uses: an Error carrying a `type`.
        this.emit('error', Object.assign(new Error(`ID "${id}" is taken`),
          { type: 'unavailable-id' }));
        return;
      }
      this.id = id ?? `guest-${Math.random().toString(36).slice(2, 8)}`;
      if (id !== undefined) held.set(id, this);
      this.emit('open', this.id);
    }, 5);
  }

  connect(target) {
    const conn = new FakeConn(this, target);
    this.conns.push(conn);
    const host = held.get(target);
    if (!host) {
      // **The behaviour this test exists for.** A free slot comes back as an
      // error on the *peer*, not on the connection, and PeerJS does not treat
      // it as fatal - it is `emitError`, not `_abort`. Fast, because it is one
      // round trip to the broker and no ICE at all.
      setTimeout(() => {
        if (!this.destroyed) {
          this.emit('error', Object.assign(
            new Error(`Could not connect to peer ${target}`),
            { type: 'peer-unavailable' }));
        }
      }, 10);
      return conn;
    }
    // A live room has to do a real handshake, so it answers much later than
    // the broker says "nobody there". That ordering is the whole bug.
    setTimeout(() => {
      if (this.destroyed || host.destroyed || conn.closed) return;
      const inbound = new FakeConn(host, this.id);
      inbound.remote = conn;
      conn.remote = inbound;
      conn.open = true;
      inbound.open = true;
      host.emit('connection', inbound);
      inbound.emit('open');
      conn.emit('open');
    }, 120);
    return conn;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this._id !== undefined && held.get(this._id) === this) {
      held.delete(this._id);
    }
    for (const c of this.conns) if (c.open) c.close();
  }
}

globalThis.Peer = FakePeer;      // loadPeerJS short-circuits on this
const peerjs = await import(join(ROOT, 'src/net/peer.js'));

// ----------------------------------------------------------------- tests --

console.log('\n=== a guest finds a hosted room ===');
{
  held.clear();
  const session = await peerjs.host();
  session.onGuest((link) => link.send(
    { t: 'lobby', room: session.room, players: [{ car: 'x' }] }));
  ok(`host took room ${session.room}`);

  const found = [];
  const close = await peerjs.list((r) => found.push(r));
  found.length === 1 && found[0].room === session.room
    ? ok(`JOIN found room ${found[0].room}`)
    : fail(`JOIN found ${found.length} room(s): `
           + JSON.stringify(found.map((f) => f.room)));
  found[0]?.hello?.t === 'lobby'
    ? ok('... and it carries the host\'s lobby as its advert')
    : fail(`no advert on the listing: ${JSON.stringify(found[0]?.hello)}`);
  close();
  session.cancel();
}

console.log('\n=== the seven empty slots must not kill the probe ===');
{
  held.clear();
  // Put the host in the *last* slot, so every earlier probe comes back
  // "peer-unavailable" first. This is the reported failure exactly.
  for (let n = 1; n < 8; n++) {
    held.set(peerjs.roomId(n), { destroyed: false, blocker: true });
  }
  const session = await peerjs.host();
  session.onGuest((link) => link.send(
    { t: 'lobby', room: session.room, players: [] }));
  for (let n = 1; n < 8; n++) held.delete(peerjs.roomId(n));  // free again

  const found = [];
  const close = await peerjs.list((r) => found.push(r));
  found.some((f) => f.room === session.room)
    ? ok(`found room ${session.room} past 7 dead slots answering first`)
    : fail('the empty slots destroyed the probe - no games found');
  close();
  session.cancel();
}

console.log('\n=== a host survives a routine peer-unavailable ===');
{
  held.clear();
  const session = await peerjs.host();
  const mine = held.get(peerjs.roomId(session.room));
  mine.emit('error', Object.assign(
    new Error('Could not connect to peer someone'),
    { type: 'peer-unavailable' }));
  await sleep(20);
  !mine.destroyed
    ? ok('the room is still open after a stray peer-unavailable')
    : fail('a routine error destroyed the host - the room vanishes');

  const found = [];
  const close = await peerjs.list((r) => found.push(r));
  found.some((f) => f.room === session.room)
    ? ok('... and a guest can still find it')
    : fail('the room is gone from the list');
  close();
  session.cancel();
}

console.log('\n=== openPeer does not leak listeners ===');
{
  held.clear();
  const session = await peerjs.host();
  const mine = held.get(peerjs.roomId(session.room));
  // One 'connection' listener from host(), plus whatever host() itself binds.
  // What must NOT still be there is openPeer's destroy-on-error handler.
  mine.emit('error', Object.assign(new Error('boom'), { type: 'network' }));
  await sleep(20);
  !mine.destroyed
    ? ok('a late error does not tear the peer down behind our back')
    : fail('openPeer\'s error handler is still bound after the peer opened');
  session.cancel();
}

console.log('\n=== nothing is hosting: the list is empty, not broken ===');
{
  held.clear();
  const found = [];
  const close = await peerjs.list((r) => found.push(r));
  found.length === 0 ? ok('no rooms, and it returned rather than hanging')
                     : fail(`found ${found.length} rooms with nobody hosting`);
  close();
}

console.log(failed ? `\n${failed} problem(s)` : '\nrooms are found');
process.exit(failed ? 1 : 0);
