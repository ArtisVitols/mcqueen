/**
 * The real transport: WebRTC between phones, over PeerJS's free broker.
 *
 * There is no server behind this game - it is a static site on GitHub Pages -
 * so the devices need somewhere to exchange connection details before they can
 * talk directly. PeerJS's public broker does that and nothing else: once the
 * handshake is done the race data goes phone to phone.
 *
 * The 93 KB library is loaded on demand, so a single-player session never
 * downloads it.
 *
 * **Rooms are numbered slots, not codes.** The owner asked for JOIN to *find*
 * the open games rather than ask for four letters read out across the room, and
 * a browser cannot scan a network - it has no mDNS, no UDP and no sockets. What
 * it can do is knock: the room ids are a fixed, short list, so a host takes the
 * first free one and a guest tries all of them and lists whoever answers. That
 * behaves exactly like discovery and needs nothing running anywhere.
 *
 * The cost is that the slots are global to the broker rather than to a house.
 * Eight of them, and the room number is on screen, so the worst case is being
 * told which one to join.
 */

const PREFIX = 'mcqueen-speedway-room-';
export const ROOM_SLOTS = 8;
const CONNECT_TIMEOUT = 20000;
// A free slot answers "peer-unavailable" almost at once, so a probe that has
// not resolved by now is a room nobody is holding.
const PROBE_TIMEOUT = 4500;
// How long a room that has *opened* is given to send its advert before it is
// listed without one. The lobby message normally arrives in the same breath;
// this only covers it being dropped, since the channel is unreliable.
const ADVERT_GRACE = 1200;

let loading = null;

/** Pull in the library once, on demand. */
function loadPeerJS() {
  if (globalThis.Peer) return Promise.resolve(globalThis.Peer);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = new URL('../../vendor/peerjs/peerjs.min.js', import.meta.url).href;
    el.onload = () => (globalThis.Peer ? resolve(globalThis.Peer)
                                       : reject(new Error('peerjs loaded but exported nothing')));
    el.onerror = () => reject(new Error('could not load peerjs'));
    document.head.appendChild(el);
  });
  return loading;
}

export const roomId = (n) => `${PREFIX}${n}`;

/**
 * Wrap a PeerJS DataConnection in the send/onMessage/close the rest of us use.
 *
 * `peer` is only destroyed by the side that owns it exclusively - a guest. A
 * host holds one peer and several connections, so closing one link must not
 * take the room down with it.
 */
function wrap(conn, peer, ownsPeer = true) {
  let handler = null;
  const link = {
    send(msg) {
      // Never throw at the caller: a dropped connection is a race that carries
      // on with an AI in that seat, not an exception in the middle of a frame.
      try { if (conn.open) conn.send(msg); } catch { /* gone; onClose will fire */ }
    },
    onMessage(fn) { handler = fn; },
    close() {
      try { conn.close(); if (ownsPeer) peer.destroy(); } catch { /* already gone */ }
    },
    onClose: null,
    peerId: conn.peer,
  };
  conn.on('data', (msg) => handler?.(msg));
  conn.on('close', () => link.onClose?.());
  conn.on('error', () => link.onClose?.());
  return link;
}

/**
 * Open a room in the first free slot and keep accepting players.
 *
 * @returns {Promise<{room: number, onGuest: function, cancel: function}>}
 *   `room` is available immediately so it can be shown; `onGuest` is called
 *   with a link for **every** player who joins.
 *
 * A callback rather than a promise, which is the whole difference between two
 * players and four: the old version resolved on the first connection and every
 * later one was dropped on the floor.
 */
export async function host(onStatus = () => {}) {
  const Peer = await loadPeerJS();
  onStatus('reaching the lobby');

  let peer = null;
  let room = 0;
  let lastErr = null;
  for (let n = 1; n <= ROOM_SLOTS && !peer; n++) {
    try {
      peer = await openPeer(Peer, roomId(n));
      room = n;
    } catch (err) {
      lastErr = err;
      // A taken slot is the expected answer, not a failure - try the next one.
      if (err.type !== 'unavailable-id') throw asPlainError(err);
    }
  }
  if (!peer) {
    throw new Error(lastErr?.type === 'unavailable-id'
      ? `all ${ROOM_SLOTS} rooms are busy - try again in a minute`
      : asPlainError(lastErr).message);
  }

  onStatus('waiting');
  // A room must not evaporate over something routine. `peer-unavailable` here
  // is somebody else's problem - an id we were asked about that nobody holds -
  // and even a broker wobble is survivable, because the guests already
  // connected are talking phone to phone by now. Report it; do not tear the
  // room down. (Before this, *any* error destroyed the peer while the screen
  // went on showing a room number that no longer existed.)
  peer.on('error', (err) => {
    if (err?.type === 'peer-unavailable') return;
    onStatus(asPlainError(err).message);
  });

  let onGuest = null;
  peer.on('connection', (conn) => {
    conn.on('open', () => onGuest?.(wrap(conn, peer, false)));
  });

  return {
    room,
    onGuest(fn) { onGuest = fn; },
    cancel() { try { peer.destroy(); } catch { /* fine */ } },
  };
}

/**
 * A peer with a fixed id, or the broker's reason for saying no.
 *
 * **Both handlers come off again the moment this settles, and that is the
 * whole point of the function.** The error handler destroys the peer, which is
 * right while we are still waiting to be let in and catastrophic afterwards:
 * PeerJS reports a great many *routine* things through `error`, and
 * `peer-unavailable` - "nobody is holding that id" - is one of them. Left
 * bound, it meant a guest knocking on eight rooms destroyed its own peer on
 * the first empty one, taking down the probe of the room that was live. The
 * broker answers "nobody there" in one round trip while a real host needs a
 * whole ICE handshake, so the empty slots always answered first and JOIN never
 * found anything. `check_rooms.mjs` is that failure, written down.
 */
function openPeer(Peer, id) {
  return new Promise((resolve, reject) => {
    const peer = new Peer(id, { debug: 0 });
    let timer = null;
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      peer.off('open', onOpen);
      peer.off('error', onError);
      fn(arg);
    };
    const onOpen = () => settle(resolve, peer);
    const onError = (err) => {
      // Only while opening. Failing to take an id leaves nothing worth
      // keeping, so the peer goes with it.
      try { peer.destroy(); } catch { /* fine */ }
      settle(reject, err);
    };
    timer = setTimeout(() => {
      try { peer.destroy(); } catch { /* fine */ }
      settle(reject, new Error('the lobby did not answer'));
    }, CONNECT_TIMEOUT);
    peer.on('open', onOpen);
    peer.on('error', onError);
  });
}

/**
 * Knock on every room and report the ones that answer.
 *
 * **Probing is joining.** A free slot rejects a connection immediately, and a
 * held one opens - at which point the host greets it with its lobby state, so
 * the advert a room shows in the list *is* the lobby. The connection to the
 * room the player picks is the one they play on; the rest are closed.
 *
 * @param {function} onRoom  called with `{room, link, hello}` per live room
 * @returns {Promise<function>} a `close()` that drops every connection still open
 */
export async function list(onRoom, onStatus = () => {}) {
  const Peer = await loadPeerJS();
  onStatus('looking for games');
  const peer = await openPeer(Peer, undefined).catch((err) => { throw asPlainError(err); });

  const open = new Map();
  const giveUp = new Map();       // room -> stop waiting on it
  // **A free slot answers on the *peer*, not on the connection**, so this is
  // the only place an empty room can be told from a slow one. PeerJS names the
  // id it could not reach in the message, which is how the answer gets back to
  // the probe that asked. Anything that is not `peer-unavailable` is the
  // broker itself failing, and then none of the eight will ever answer.
  peer.on('error', (err) => {
    if (err?.type === 'peer-unavailable') {
      const at = /-room-(\d+)\b/.exec(err.message || '');
      // If the id cannot be read out of the message, give up on *nothing* and
      // let the per-probe timeout do it. Cancelling them all would be the
      // original bug wearing a hat: one empty slot killing the live room.
      if (at) giveUp.get(+at[1])?.();
      return;
    }
    for (const stop of giveUp.values()) stop();
  });

  const probes = [];
  for (let n = 1; n <= ROOM_SLOTS; n++) {
    probes.push(new Promise((resolve) => {
      const conn = peer.connect(roomId(n), { reliable: false });
      let timer = null;
      let grace = null;
      let done = false;
      const stop = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(grace);
        try { conn.close(); } catch { /* fine */ }
        resolve();
      };
      const report = (hello) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(grace);
        const link = wrap(conn, peer, false);
        open.set(n, link);
        onRoom({ room: n, link, hello });
        resolve();
      };
      giveUp.set(n, stop);
      timer = setTimeout(stop, PROBE_TIMEOUT);
      // The first thing a live host says is its lobby; that is the advert, and
      // it is what fills in the car and the player count.
      conn.on('data', report);
      // **A room that accepts a connection is a live room**, advert or no
      // advert. This channel is unreliable on purpose - it becomes the race
      // link - so hanging the whole listing on one packet arriving is a game
      // that intermittently cannot be found. Wait a moment for the advert,
      // then list it anyway.
      conn.on('open', () => {
        if (!done) grace = setTimeout(() => report(null), ADVERT_GRACE);
      });
      conn.on('error', stop);
      conn.on('close', stop);
    }));
  }
  await Promise.all(probes);
  onStatus(open.size ? 'found' : 'none');

  return (keep = null) => {
    for (const [n, link] of open) if (n !== keep) link.close();
    if (keep === null) { try { peer.destroy(); } catch { /* fine */ } }
  };
}

/** Join one room directly, by number. */
export async function join(room, onStatus = () => {}) {
  const Peer = await loadPeerJS();
  onStatus('reaching the lobby');
  const peer = await openPeer(Peer, undefined).catch((err) => { throw asPlainError(err); });

  onStatus('knocking');
  const conn = peer.connect(roomId(room), { reliable: false });
  return new Promise((resolve, reject) => {
    let settled = false;
    // Unbound once this settles, for the same reason `openPeer` unbinds its
    // own: after the link is up, `peer-unavailable` is routine traffic and
    // must not reach back into the handshake that has already finished.
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      peer.off('error', onError);
      fn(arg);
    };
    const onError = (err) => settle(reject, asPlainError(err));
    const timer = setTimeout(
      () => settle(reject, new Error(`nobody answered in room ${room}`)),
      CONNECT_TIMEOUT);
    conn.on('open', () => settle(resolve, wrap(conn, peer)));
    peer.on('error', onError);
  });
}

/**
 * PeerJS errors are objects with a `type`. Turn the ones that will actually
 * happen into something a person can act on, because "unavailable-id" on a
 * screen is nobody's idea of help.
 */
function asPlainError(err) {
  const type = err?.type || '';
  if (type === 'peer-unavailable') return new Error('nobody is hosting that room');
  if (type === 'unavailable-id') return new Error('that room is already taken');
  if (type === 'network' || type === 'server-error') return new Error('could not reach the lobby');
  if (type === 'browser-incompatible') return new Error('this browser cannot do multiplayer');
  return new Error(err?.message || 'the connection failed');
}
