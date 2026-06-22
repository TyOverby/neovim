// wasm/web/engine-worker.js - Neovim engine endpoint, run in a Web Worker.
//
// The browser analogue of wasm/worker.js. Hosts the Neovim engine wasm
// (`nvim --embed`) directly in this Worker and backs its stdin/stdout (fd 0/1)
// with a shared-memory RingChannel (wasm/sab.js). The page never shares
// anything with the engine except the SharedArrayBuffer; all RPC flows through
// it. Off the main thread the engine may block in poll() via Atomics.wait.
'use strict';

// sab.js defines the global RingChannel (it has a browser branch).
importScripts('sab.js');

onmessage = function (e) {
  var d = e.data || {};
  // 'server' role: out = engine->page ring, in = page->engine ring.
  var channel = new RingChannel(d.sab, d.cap, 'server');

  // pre.js reads these globals before the module boots (Emscripten's own
  // `var Module` shadows a Module we might set, so we use plain globals).
  self.__nvimServerChannel = channel;
  self.__nvimCanBlockSync = true;             // off main thread: Atomics.wait OK
  self.__nvimArgs = ['--embed'].concat(d.args || []);

  // Surface engine stdout/stderr (panics, messages) back to the page console.
  self.Module = self.Module || {};
  self.Module.print = function (s) { try { postMessage({ kind: 'stdout', text: s }); } catch (_e) {} };
  self.Module.printErr = function (s) { try { postMessage({ kind: 'stderr', text: s }); } catch (_e) {} };

  // Booting the (non-MODULARIZE) Emscripten module starts the engine. main()
  // then runs the libuv loop forever on this thread, blocking in Atomics.wait
  // between events, so importScripts('nvim.js') effectively never returns.
  postMessage({ kind: 'booting' });
  importScripts('nvim.js');
};
