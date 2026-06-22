// wasm/sab.js - SharedArrayBuffer byte-stream transport.
//
// A bidirectional, single-producer/single-consumer byte channel backed by a
// SharedArrayBuffer. Two independent ring buffers (one per direction) carry the
// raw msgpack-RPC byte stream between the Neovim server and the UI client.
//
// This is the "separate processes + shared memory" substrate. In Node the two
// endpoints are the main thread and a worker_thread; in the browser they are
// the page and a Web Worker. The code is identical in both because it relies
// only on SharedArrayBuffer + Atomics.
//
// Layout (two rings, "a->b" and "b->a"):
//   per ring:  [ ctrl: Int32Array(4) ][ data: Uint8Array(CAP) ]
//     ctrl[0] = head  (write position mod CAP; written by producer only)
//     ctrl[1] = tail  (read  position mod CAP; written by consumer only)
//     ctrl[2] = closed flag
//   Single-producer/single-consumer, so head/tail need no locking; we use
//   Atomics for visibility + futex wait/notify on `head` to block the reader.
'use strict';

const CTRL_INTS = 4;
const CTRL_BYTES = CTRL_INTS * 4;
const HEAD = 0;
const TAIL = 1;
const CLOSED = 2;

function ringRegionBytes(cap) {
  return CTRL_BYTES + cap;
}

class Ring {
  constructor(sab, byteOffset, cap) {
    this.cap = cap;
    this.ctrl = new Int32Array(sab, byteOffset, CTRL_INTS);
    this.data = new Uint8Array(sab, byteOffset + CTRL_BYTES, cap);
  }

  available() {
    const head = Atomics.load(this.ctrl, HEAD);
    const tail = Atomics.load(this.ctrl, TAIL);
    return (head - tail + this.cap) % this.cap;
  }

  freeSpace() {
    return this.cap - 1 - this.available();
  }

  // Producer: write as many of u8[off..off+len) as fit; returns bytes written.
  write(u8, off, len) {
    let n = Math.min(len, this.freeSpace());
    let head = Atomics.load(this.ctrl, HEAD);
    for (let i = 0; i < n; i++) {
      this.data[head] = u8[off + i];
      head = (head + 1) % this.cap;
    }
    Atomics.store(this.ctrl, HEAD, head);
    Atomics.notify(this.ctrl, HEAD);
    return n;
  }

  // Consumer: read up to len bytes into u8 at off; returns bytes read.
  read(u8, off, len) {
    let n = Math.min(len, this.available());
    let tail = Atomics.load(this.ctrl, TAIL);
    for (let i = 0; i < n; i++) {
      u8[off + i] = this.data[tail];
      tail = (tail + 1) % this.cap;
    }
    Atomics.store(this.ctrl, TAIL, tail);
    return n;
  }

  // Consumer: block (off-main-thread only) until data is available or timeout
  // (ms; Infinity for no timeout). Returns true if data may be available.
  waitReadable(timeout) {
    if (this.available() > 0) return true;
    const head = Atomics.load(this.ctrl, HEAD);
    Atomics.wait(this.ctrl, HEAD, head, timeout === undefined ? Infinity : timeout);
    return this.available() > 0;
  }

  // Consumer: main-thread-safe async wait. Returns a Promise<boolean>.
  waitReadableAsync(timeout) {
    if (this.available() > 0) return Promise.resolve(true);
    const head = Atomics.load(this.ctrl, HEAD);
    const r = Atomics.waitAsync(this.ctrl, HEAD, head,
                                timeout === undefined ? Infinity : timeout);
    if (!r.async) return Promise.resolve(this.available() > 0);
    return r.value.then(() => this.available() > 0);
  }

  isClosed() { return Atomics.load(this.ctrl, CLOSED) === 1; }
  close() { Atomics.store(this.ctrl, CLOSED, 1); Atomics.notify(this.ctrl, HEAD); }
}

class RingChannel {
  // role: 'server' or 'client'. Server writes ring0 / reads ring1; client the
  // reverse, so the two endpoints' "in"/"out" line up.
  constructor(sab, cap, role) {
    this.sab = sab;
    this.cap = cap;
    const r0 = new Ring(sab, 0, cap);
    const r1 = new Ring(sab, ringRegionBytes(cap), cap);
    if (role === 'server') { this.out = r0; this.in = r1; }
    else { this.out = r1; this.in = r0; }
  }

  static byteLength(cap) { return 2 * ringRegionBytes(cap); }

  static create(cap) {
    const sab = new SharedArrayBuffer(RingChannel.byteLength(cap));
    return { sab, cap };
  }
}

module.exports = { RingChannel, Ring };
