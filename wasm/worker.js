// wasm/worker.js - Neovim engine endpoint, run in a Node worker_thread.
//
// Hosts the Neovim engine wasm (`nvim --embed`) *directly* in this worker and
// backs its stdin/stdout (fd 0/1) with a shared-memory RingChannel (wasm/sab.js)
// instead of real pipes. The main thread only ever touches the
// SharedArrayBuffer; it never shares fds or pipes with the engine. That is the
// property the browser target needs (page <-> Worker over a SAB), and it is what
// stage 2 switched to (see wasm/stage2.md): MEMFS+NODEFS makes fd 0/1 virtual
// streams, so wasm/nvim_io.js can install ring-channel stream ops on them and
// the engine blocks in poll() via Atomics.wait (allowed off the main thread).
//
// (Stage 1 launched the engine as a child `node nvim.js --embed` process and
// bridged its stdio pipes to the SAB. That child + bridge are gone now.)
'use strict';

const { workerData } = require('worker_threads');
const path = require('path');
const { RingChannel } = require(path.join(__dirname, 'sab.js'));

// 'server' role: out=engine->client ring, in=client->engine ring.
const channel = new RingChannel(workerData.sab, workerData.cap, 'server');

// worker_threads inherit the parent's env, so the engine would otherwise share
// the client's $NVIM_LOG_FILE and interleave logs. Give the engine its own.
if (process.env.NVIM_LOG_FILE) {
  process.env.NVIM_LOG_FILE = process.env.NVIM_LOG_FILE + '.engine';
}

// Hand the channel + argv to the engine wasm. pre.js reads these globals (it
// can't see a require()-set Module because Emscripten's own `var Module`
// shadows it). canBlockSync=true: we are off the main thread, so the engine may
// Atomics.wait in poll().
globalThis.__nvimServerChannel = channel;
globalThis.__nvimCanBlockSync = true;
globalThis.__nvimArgs = ['--embed'].concat(workerData.args || []);

// When the engine exits (e.g. `:q`), close the rings so the client sees EOF on
// its channel and runs its own teardown (restoring the terminal). The engine
// quits via process.exit() inside this worker, so hook the worker's exit.
process.on('exit', function () {
  try { channel.out.close(); channel.in.close(); } catch (e) { /* ignore */ }
});

// Booting the (non-MODULARIZE) Emscripten module starts the engine immediately.
require(path.join(__dirname, 'nvim.js'));
