/**
 * The real transport: WebRTC between two phones, over PeerJS's free broker.
 *
 * There is no server behind this game - it is a static site on GitHub Pages -
 * so the two devices need somewhere to exchange connection details before they
 * can talk directly. PeerJS's public broker does that and nothing else: once
 * the handshake is done the race data goes phone to phone.
 *
 * The 93 KB library is loaded on demand, so a single-player session never
 * downloads it.
 *
 * Room codes are four letters from an alphabet with no O/0 or I/1 in it,
 * because they get read aloud across a room to a five-year-old.
 */

const PREFIX = 'mcqueen-speedway-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 4;
const CONNECT_TIMEOUT = 20000;

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

export function makeCode(rng = Math.random) {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  return out;
}

/** Wrap a PeerJS DataConnection in the send/onMessage/close the rest of us use. */
function wrap(conn, peer) {
  let handler = null;
  const link = {
    send(msg) {
      // Never throw at the caller: a dropped connection is a race that carries
      // on with an AI in that seat, not an exception in the middle of a frame.
      try { if (conn.open) conn.send(msg); } catch { /* gone; onClose will fire */ }
    },
    onMessage(fn) { handler = fn; },
    close() { try { conn.close(); peer.destroy(); } catch { /* already gone */ } },
    onClose: null,
    peerId: conn.peer,
  };
  conn.on('data', (msg) => handler?.(msg));
  conn.on('close', () => link.onClose?.());
  conn.on('error', () => link.onClose?.());
  return link;
}

/**
 * Open a room and wait for the other person.
 *
 * @returns {Promise<{code: string, waitForGuest: Promise<object>, cancel: function}>}
 *   `code` is available immediately so it can be read out; the promise settles
 *   when somebody joins.
 */
export async function host(onStatus = () => {}) {
  const Peer = await loadPeerJS();
  const code = makeCode();
  onStatus('reaching the lobby');

  const peer = new Peer(PREFIX + code, { debug: 0 });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the lobby did not answer')), CONNECT_TIMEOUT);
    peer.on('open', () => { clearTimeout(timer); resolve(); });
    peer.on('error', (err) => { clearTimeout(timer); reject(asPlainError(err)); });
  });

  onStatus('waiting');
  let cancelled = false;
  const waitForGuest = new Promise((resolve, reject) => {
    peer.on('connection', (conn) => {
      conn.on('open', () => resolve(wrap(conn, peer)));
    });
    peer.on('error', (err) => { if (!cancelled) reject(asPlainError(err)); });
  });

  return {
    code,
    waitForGuest,
    cancel() { cancelled = true; try { peer.destroy(); } catch { /* fine */ } },
  };
}

/** Join a room by its code. */
export async function join(code, onStatus = () => {}) {
  const Peer = await loadPeerJS();
  onStatus('reaching the lobby');

  const peer = new Peer(undefined, { debug: 0 });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the lobby did not answer')), CONNECT_TIMEOUT);
    peer.on('open', () => { clearTimeout(timer); resolve(); });
    peer.on('error', (err) => { clearTimeout(timer); reject(asPlainError(err)); });
  });

  onStatus('knocking');
  const conn = peer.connect(PREFIX + code.toUpperCase(), { reliable: false });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`nobody answered at ${code.toUpperCase()}`)), CONNECT_TIMEOUT);
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
  if (type === 'peer-unavailable') return new Error('nobody is hosting that code');
  if (type === 'unavailable-id') return new Error('that code is already taken - try again');
  if (type === 'network' || type === 'server-error') return new Error('could not reach the lobby');
  if (type === 'browser-incompatible') return new Error('this browser cannot do multiplayer');
  return new Error(err?.message || 'the connection failed');
}
