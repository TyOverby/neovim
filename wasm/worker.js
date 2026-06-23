// wasm/worker.js - Neovim engine endpoint, run in a Node worker_thread.
//
// Hosts the Neovim engine wasm (`nvim --embed`) directly in this worker and
// backs its stdin/stdout (fd 0/1) with a postMessage channel to the main thread
// (wasm/nvim_io.js installs the stream ops). The main thread only ever exchanges
// messages with the engine; it never shares fds, pipes, or memory. That is the
// property the browser target needs (page <-> Worker over postMessage) and the
// browser host (wasm/web/engine-worker.js) is the same shape.
//
// The engine does NOT block: nvim's poll() suspends via JSPI and resumes when a
// message arrives, so this worker keeps returning to its event loop to receive
// the parent's messages.
'use strict';

const { parentPort, workerData } = require('worker_threads');
const path = require('path');

// The channel object wasm/nvim_io.js reads (Module.nvimChannel) to back fd 0/1.
const channel = {
  inQueue: [],         // bytes from the main thread; drained on fd-0 read
  closed: false,       // parent went away -> fd-0 read reports EOF
  notify: null,        // nvim_io installs this; we call it after push/close
  postOutput: function (u8) { parentPort.postMessage(u8.buffer, [u8.buffer]); },
};

parentPort.on('message', function (d) {
  channel.inQueue.push({ buf: new Uint8Array(d), off: 0 });
  if (channel.notify) { channel.notify(); }
});
// The main thread closing its end of the port shows up as 'close'.
parentPort.on('close', function () {
  channel.closed = true;
  if (channel.notify) { channel.notify(); }
});

// worker_threads inherit the parent's env, so the engine would otherwise share
// the client's $NVIM_LOG_FILE and interleave logs. Give the engine its own.
if (process.env.NVIM_LOG_FILE) {
  process.env.NVIM_LOG_FILE = process.env.NVIM_LOG_FILE + '.engine';
}

// Hand the channel + argv to the engine wasm. pre.js reads these globals (it
// can't see a require()-set Module because Emscripten's own `var Module`
// shadows it).
globalThis.__nvimChannel = channel;
globalThis.__nvimArgs = ['--embed'].concat(workerData.args || []);

// Booting the (non-MODULARIZE) Emscripten module starts the engine. When it
// exits (e.g. :q) the worker thread exits, which the parent observes as the
// worker's 'exit' event and treats as channel EOF.
require(path.join(__dirname, 'nvim.js'));
