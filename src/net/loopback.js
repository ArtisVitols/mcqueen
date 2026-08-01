/**
 * Two tabs on one machine, over BroadcastChannel.
 *
 * Same shape as the PeerJS transport, no broker and no WebRTC - so a browser
 * test can drive the entire multiplayer path, including the menus and the
 * render loop, without depending on somebody else's free service being up.
 * Reached with `?net=loopback`.
 */

const CHANNEL = 'mcqueen-speedway-loopback';

function wrap(channel, mine, theirs) {
  let handler = null;
  const link = {
    send(msg) { channel.postMessage({ to: theirs, msg }); },
    onMessage(fn) { handler = fn; },
    close() { try { channel.close(); } catch { /* already gone */ } },
    onClose: null,
    peerId: theirs,
  };
  channel.onmessage = (e) => {
    if (e.data?.to !== mine) return;
    if (e.data.msg === '__bye__') link.onClose?.();
    else handler?.(e.data.msg);
  };
  return link;
}

export async function host(onStatus = () => {}) {
  const code = 'LOOP';
  const channel = new BroadcastChannel(CHANNEL);
  onStatus('waiting');

  const waitForGuest = new Promise((resolve) => {
    const open = (e) => {
      if (e.data?.to !== 'host' || e.data.msg !== '__hello__') return;
      channel.onmessage = null;
      channel.postMessage({ to: 'guest', msg: '__welcome__' });
      resolve(wrap(channel, 'host', 'guest'));
    };
    channel.onmessage = open;
  });

  return { code, waitForGuest, cancel() { try { channel.close(); } catch { /* fine */ } } };
}

export async function join(code, onStatus = () => {}) {
  void code;
  const channel = new BroadcastChannel(CHANNEL);
  onStatus('knocking');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('nobody is hosting')), 20000);
    channel.onmessage = (e) => {
      if (e.data?.to !== 'guest' || e.data.msg !== '__welcome__') return;
      clearTimeout(timer);
      channel.onmessage = null;
      resolve(wrap(channel, 'guest', 'host'));
    };
    // The host may not be listening yet, so keep knocking.
    const knock = setInterval(() => channel.postMessage({ to: 'host', msg: '__hello__' }), 250);
    setTimeout(() => clearInterval(knock), 20000);
  });
}
