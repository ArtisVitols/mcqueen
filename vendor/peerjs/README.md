# peerjs 1.5.4

The UMD build, taken verbatim from https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js
and vendored exactly as three.js is - this project has no build step and no npm
at runtime.

The UMD file rather than the ES module one on purpose: `dist/bundler.mjs` has
bare imports (`peerjs-js-binarypack`, `webrtc-adapter`) that only a bundler can
resolve. This one is self-contained and sets `window.Peer`.

Only `src/net/peer.js` touches it, and only when somebody chooses multiplayer -
a single-player session never downloads these 93 KB.

MIT licence, (c) 2015 Michelle Bu and Eric Zhang.
