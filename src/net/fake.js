/**
 * A transport that runs in one process, with latency and loss you choose.
 *
 * This exists so the whole netplay stack can be tested without a browser, a
 * broker or two phones - which means it can be run on every change instead of
 * only when somebody happens to have a second device to hand. Messages are
 * queued against a clock the test advances by hand, so a run is deterministic
 * and a failure is reproducible.
 */
export class FakeLink {
  /**
   * @param {object} opts
   * @param {number} opts.latency  one-way delay, seconds
   * @param {number} opts.jitter   +/- variation on that
   * @param {number} opts.loss     0..1 chance a packet never arrives
   * @param {function} opts.rng    deterministic source for jitter and loss
   */
  constructor({ latency = 0, jitter = 0, loss = 0, rng = () => 0.5 } = {}) {
    this.latency = latency;
    this.jitter = jitter;
    this.loss = loss;
    this.rng = rng;
    this.now = 0;
    this.a = makeEnd();
    this.b = makeEnd();
    this.a.other = this.b;
    this.b.other = this.a;
    for (const end of [this.a, this.b]) {
      end.send = (msg) => this.queue(end.other, msg);
      end.close = () => { end.closed = true; };
      end.onMessage = (fn) => { end.handler = fn; };
    }
    this.dropped = 0;
    this.delivered = 0;
  }

  queue(to, msg) {
    if (this.rng() < this.loss) { this.dropped++; return; }
    const wobble = (this.rng() * 2 - 1) * this.jitter;
    to.queue.push({ at: this.now + Math.max(0, this.latency + wobble), msg });
  }

  /** Advance the shared clock and deliver whatever is due. */
  step(dt) {
    this.now += dt;
    for (const end of [this.a, this.b]) {
      // Not necessarily in order: jitter can reorder packets, which is exactly
      // what the sequence numbers in net.js are there to survive.
      const due = end.queue.filter((p) => p.at <= this.now);
      if (!due.length) continue;
      end.queue = end.queue.filter((p) => p.at > this.now);
      for (const p of due) {
        this.delivered++;
        if (!end.closed) end.handler?.(p.msg);
      }
    }
  }
}

function makeEnd() {
  return { queue: [], handler: null, closed: false, other: null, send: null, close: null, onMessage: null };
}
