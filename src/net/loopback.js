/**
 * Several tabs on one machine, over BroadcastChannel.
 *
 * Same shape as the PeerJS transport, no broker and no WebRTC - so a browser
 * test can drive the entire multiplayer path, including the menus and the
 * render loop, without depending on somebody else's free service being up.
 * Reached with `?net=loopback`.
 *
 * **Every message is addressed.** One channel now carries a host and up to
 * three guests, so a link filters on its own name rather than owning the
 * channel's single `onmessage` - which is what the two-player version did, and
 * what a third tab would have quietly broken.
 */

const CHANNEL = 'mcqueen-speedway-loopback';
const HOST = 'host';
const ROOM = 1;                     // there is only ever one room in a browser

let seq = 0;
const newId = () => `g${Date.now().toString(36)}-${seq++}`;

/**
 * Fan one channel out to many links.
 *
 * The channel is shared, so closing a link must not close it: the host holds
 * one channel and several players.
 */
function bus(channel) {
  const routes = new Map();         // address -> handler
  const closers = new Map();        // address -> onClose
  channel.onmessage = (e) => {
    const { to, msg } = e.data || {};
    if (!routes.has(to)) return;
    if (msg === '__bye__') closers.get(to)?.();
    else routes.get(to)(msg);
  };
  return {
    link(mine, theirs) {
      const l = {
        send(msg) { channel.postMessage({ to: theirs, from: mine, msg }); },
        onMessage(fn) { routes.set(mine, fn); },
        close() {
          try { channel.postMessage({ to: theirs, from: mine, msg: '__bye__' }); } catch { /* gone */ }
          routes.delete(mine);
          closers.delete(mine);
        },
        set onClose(fn) { closers.set(mine, fn); },
        get onClose() { return closers.get(mine); },
        peerId: theirs,
      };
      routes.set(mine, () => {});
      return l;
    },
    channel,
  };
}

export async function host(onStatus = () => {}) {
  const channel = new BroadcastChannel(CHANNEL);
  const b = bus(channel);
  onStatus('waiting');

  let onGuest = null;
  // Knocks are addressed to the host by name; everything after that is
  // addressed to the guest's own id, so several can be in at once.
  const knocks = new BroadcastChannel(CHANNEL);
  knocks.onmessage = (e) => {
    const { to, from, msg } = e.data || {};
    if (to !== HOST || msg !== '__hello__' || !from) return;
    knocks.postMessage({ to: from, from: HOST, msg: '__welcome__' });
    onGuest?.(b.link(`${HOST}:${from}`, from));
  };

  return {
    room: ROOM,
    onGuest(fn) { onGuest = fn; },
    cancel() {
      try { channel.close(); } catch { /* fine */ }
      try { knocks.close(); } catch { /* fine */ }
    },
  };
}

/**
 * Knock once and report the room if anybody answers.
 *
 * The browser only ever has one host, so this is `join` with a timeout instead
 * of a rejection - the same contract the PeerJS version offers, so `main.js`
 * has one code path for both.
 */
export async function list(onRoom, onStatus = () => {}) {
  onStatus('looking for games');
  const link = await join(ROOM, () => {}, 2500).catch(() => null);
  if (!link) { onStatus('none'); return () => {}; }
  // The host greets a new connection with its lobby; that is the advert.
  const hello = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 2500);
    link.onMessage((msg) => { clearTimeout(timer); resolve(msg); });
  });
  onRoom({ room: ROOM, link, hello });
  onStatus('found');
  return (keep = null) => { if (keep !== ROOM) link.close(); };
}

export async function join(room, onStatus = () => {}, timeout = 20000) {
  void room;
  const mine = newId();
  const channel = new BroadcastChannel(CHANNEL);
  const b = bus(channel);
  onStatus('knocking');
  return new Promise((resolve, reject) => {
    const hello = new BroadcastChannel(CHANNEL);
    // Stop knocking *before* closing the channel, both on success and on
    // giving up: an interval still posting into a closed BroadcastChannel
    // throws once a second for the rest of the timeout, which is a page error
    // in a test and a console full of noise on a phone.
    const done = (fn) => {
      clearInterval(knock);
      clearTimeout(timer);
      try { hello.close(); } catch { /* fine */ }
      fn();
    };
    const knock = setInterval(
      () => hello.postMessage({ to: HOST, from: mine, msg: '__hello__' }), 250);
    const timer = setTimeout(() => done(() => reject(new Error('nobody is hosting'))), timeout);
    hello.onmessage = (e) => {
      if (e.data?.to !== mine || e.data.msg !== '__welcome__') return;
      done(() => resolve(b.link(mine, `${HOST}:${mine}`)));
    };
  });
}
