// wasm/web/engine-worker.js - Neovim engine endpoint, run in a Web Worker.
//
// The browser analogue of wasm/worker.js. Hosts the Neovim engine wasm
// (`nvim --embed`) directly in this Worker and backs its stdin/stdout (fd 0/1)
// with a postMessage channel to the page (wasm/nvim_io.js installs the stream
// ops). The page and the engine only ever exchange messages -- no shared memory,
// so the page needs no COOP/COEP / cross-origin isolation.
//
// Protocol with the page:
//   page -> worker:  first message {args, env, cwd, filesystem}  (init); then
//                    ArrayBuffers (RPC input)
//   worker -> page:  ArrayBuffers (RPC output); {kind:'booting'|'stdout'|'stderr'
//                    |'exit'} status objects
'use strict';

var started = false;

onmessage = function (e) {
  if (!started) {
    started = true;
    var init = e.data || {};
    var args = init.args || [];

    // The channel object wasm/nvim_io.js reads (Module.nvimChannel).
    var channel = {
      inQueue: [],
      closed: false,
      notify: null,
      postOutput: function (u8) { postMessage(u8.buffer, [u8.buffer]); },
    };
    self.__nvimChannel = channel;
    self.__nvimArgs = ['--embed'].concat(args);

    // create() runtime config (env/cwd/filesystem) travels in the same init
    // message and is handed to the engine via the __nvim* globals pre.js reads,
    // mirroring the Node host (wasm/worker.js) exactly.
    if (init.env) { self.__nvimEnv = init.env; }
    if (init.filesystem) { self.__nvimFiles = init.filesystem; }
    if (typeof init.cwd === 'string') { self.__nvimCwd = init.cwd; }

    // Surface engine stdout/stderr + exit back to the page.
    self.Module = self.Module || {};
    self.Module.print = function (s) { try { postMessage({ kind: 'stdout', text: s }); } catch (_e) {} };
    self.Module.printErr = function (s) { try { postMessage({ kind: 'stderr', text: s }); } catch (_e) {} };
    self.Module.onExit = function () { try { postMessage({ kind: 'exit' }); } catch (_e) {} };

    postMessage({ kind: 'booting' });
    importScripts('nvim.js');   // boots the engine; main() runs the libuv loop
    return;
  }

  // After init, every message is RPC input bytes (a transferred ArrayBuffer).
  var ch = self.__nvimChannel;
  ch.inQueue.push({ buf: new Uint8Array(e.data), off: 0 });
  if (ch.notify) { ch.notify(); }
};
