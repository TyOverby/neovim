// wasm/worker.js - Neovim server endpoint, run in a Node worker_thread.
//
// Exposes an `nvim --embed` msgpack-RPC server to the main thread over the
// shared-memory RingChannel (wasm/sab.js). The main thread only ever touches
// the SharedArrayBuffer; it never shares fds or pipes with the engine. That is
// the property we need for the browser target (page <-> Worker over a SAB).
//
// Node-stage implementation note
// ------------------------------
// Today the engine is launched as a child `node nvim.js --embed` process and
// this worker bridges its stdio pipes to the SAB (the pipe-based RPC path is
// already working). The browser stage instead hosts the engine wasm *directly*
// in this worker and backs its stdin/stdout fds with the SAB (see
// wasm/nvim_io.js installChannelStream), blocking in poll() via Atomics.wait -
// at which point the child process and this bridge disappear, but the
// main-thread/SAB contract is unchanged.
'use strict';

const { workerData } = require('worker_threads');
const { spawn } = require('child_process');
const path = require('path');
const { RingChannel } = require(path.join(__dirname, 'sab.js'));

const channel = new RingChannel(workerData.sab, workerData.cap, 'server');

const child = spawn(process.execPath,
  [path.join(__dirname, 'nvim.js'), '--', '--embed'].concat(workerData.args || []),
  { stdio: ['pipe', 'pipe', 'inherit'] });

// engine stdout -> client (over shared memory)
child.stdout.on('data', (d) => {
  let off = 0;
  while (off < d.length) {
    off += channel.out.write(d, off, d.length - off);
  }
});
child.on('exit', (code) => { channel.out.close(); process.exit(code || 0); });

// client (shared memory) -> engine stdin. Polled on the worker's event loop so
// child.stdout 'data' keeps flowing. (The browser stage blocks in the engine's
// poll() via Atomics.wait instead of polling here.)
const inbuf = Buffer.alloc(workerData.cap);
const timer = setInterval(() => {
  if (channel.in.isClosed()) { clearInterval(timer); child.stdin.end(); return; }
  if (channel.in.available() > 0) {
    const n = channel.in.read(inbuf, 0, inbuf.length);
    if (n > 0) {
      child.stdin.write(Buffer.from(inbuf.subarray(0, n)));
    }
  }
}, 2);
