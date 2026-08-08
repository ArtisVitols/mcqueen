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

/** A peer with a fixed id, or the broker's reason for saying no. */
function openPeer(Peer, id) {
  return new Promise((resolve, reject) => {
    const peer = new Peer(id, { debug: 0 });
    const timer = setTimeout(() => {
      try { peer.destroy(); } catch { /* fine */ }
      reject(new Error('the lobby did not answer'));
    }, CONNECT_TIMEOUT);
    peer.on('open', () => { clearTimeout(timer); resolve(peer); });
    peer.on('error', (err) => {
      clearTimeout(timer);
      try { peer.destroy(); } catch { /* fine */ }
      reject(err);
    });
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
  const probes = [];
  for (let n = 1; n <= ROOM_SLOTS; n++) {
    probes.push(new Promise((resolve) => {
      const conn = peer.connect(roomId(n), { reliable: false });
      const timer = setTimeout(() => { try { conn.close(); } catch { /* fine */ } resolve(); },
        PROBE_TIMEOUT);
      // The first thing a live host says is its lobby; that is the advert.
      conn.on('data', (hello) => {
        if (open.has(n)) return;
        clearTimeout(timer);
        const link = wrap(conn, peer, false);
        open.set(n, link);
        onRoom({ room: n, link, hello });
        resolve();
      });
      conn.on('error', () => { clearTimeout(timer); resolve(); });
      conn.on('close', () => { clearTimeout(timer); resolve(); });
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
    const timer = setTimeout(
      () => reject(new Error(`nobody answered in room ${room}`)), CONNECT_TIMEOUT);
    conn.on('open', () => { clearTimeout(timer); resolve(wrap(conn, peer)); });
    peer.on('error', (err) => { clearTimeout(timer); reject(asPlainError(err)); });
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
