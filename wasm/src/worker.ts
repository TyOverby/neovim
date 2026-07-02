// wasm/src/worker.ts - Neovim engine endpoint, run in a Node worker_thread.
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
//
// Compiled (by wasm/build-ts.sh) to a classic Node CommonJS script worker.js
// (gitignored) -- it is loaded by `new Worker(path)` and require()s nvim.js +
// proxy-client.js from its own directory at runtime, so it stays require-based
// and module-wrapper-free. This TypeScript is the SOURCE OF TRUTH.
'use strict';

const { parentPort, workerData } = require('worker_threads');
const path = require('path');

// The channel object wasm/nvim_io.js reads (Module.nvimChannel) to back fd 0/1.
const channel = {
  inQueue: [] as any[],   // bytes from the main thread; drained on fd-0 read
  closed: false,          // parent went away -> fd-0 read reports EOF
  notify: null as null | (() => void),  // nvim_io installs this; we call it after push/close
  postOutput: function (u8: Uint8Array) { parentPort.postMessage(u8.buffer, [u8.buffer]); },
};

parentPort.on('message', function (d: any) {
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
const G = globalThis as any;
G.__nvimChannel = channel;
G.__nvimArgs = ['--embed'].concat(workerData.args || []);

// The create() runtime config travels the same seam as args: the Node transport
// puts it on workerData, we forward it onto the __nvim* globals pre.js reads.
// (The browser analogue is engine-worker.js doing the same off its init message.)
if (workerData.env) { G.__nvimEnv = workerData.env; }
if (workerData.filesystem) { G.__nvimFiles = workerData.filesystem; }
if (typeof workerData.cwd === 'string') { G.__nvimCwd = workerData.cwd; }

// Stage 4 (additive/opt-in): if a proxy URL was supplied, open the IO-proxy
// WebSocket and wire the shared proxy client, the Node analogue of
// engine-worker.js's setupProxy. This is the minimal symmetric seam -- the goal
// is just that globalThis.__nvimProxy exists for later phases' js-library to
// find. Absent => do nothing (current behavior; the e2e test never sets it). A
// connection failure must not crash the worker.
if (workerData.proxy && workerData.proxy.url) {
  try {
    const { createProxyClient } = require(path.join(__dirname, 'proxy-client.js'));
    // Resolve `ws` robustly. worker.js is copied into build-wasm/bin (where there
    // is no node_modules), so a bare require('ws') fails there. Try, in order:
    // a workerData-provided path, a bare require (when worker.js runs in-tree),
    // and the repo's web-bundle node_modules (../../wasm/web/node_modules from
    // build-wasm/bin). The web bundle is where build-nvim.sh npm-installs ws.
    let WebSocket: any = null;
    const wsCandidates: string[] = [];
    if (workerData.proxy.wsModule) { wsCandidates.push(workerData.proxy.wsModule); }
    wsCandidates.push('ws');
    wsCandidates.push(path.resolve(__dirname, '..', '..', 'wasm', 'web', 'node_modules', 'ws'));
    wsCandidates.push(path.resolve(__dirname, 'node_modules', 'ws'));
    for (const cand of wsCandidates) {
      try { WebSocket = require(cand); break; } catch (_e) { /* try next */ }
    }
    if (!WebSocket) { throw new Error("the 'ws' npm package could not be resolved"); }
    const ws = new WebSocket(workerData.proxy.url);
    const transport: any = {
      send: function (data: any) { ws.send(data); },
      close: function () { try { ws.close(); } catch (_e) {} },
    };
    const client = createProxyClient(transport);
    G.__nvimProxy = client;
    // The FS-proxy js-library mounts the server's filesystem at the engine's
    // root, except the shadow subtrees (its built-in default: the packaged
    // runtime + /dev + /proc). A host may override the list via workerData.
    if (Array.isArray(workerData.proxy.shadows)) {
      G.__nvimProxyShadows = workerData.proxy.shadows;
    }
    ws.on('message', function (d: any) { if (transport.onFrame) { transport.onFrame(d); } });
    ws.on('open', function () {
      client.hello({ nvimSocket: workerData.proxy.nvimSocket })
        .catch(function () { /* ignore; engine keeps running */ });
    });
    ws.on('close', function () { if (client.onTransportClosed) { client.onTransportClosed(); } });
    ws.on('error', function () { /* ignore; transport errors surface as close */ });
  } catch (e: any) {
    // proxy-client.js or ws missing -> skip the seam; the engine still boots
    // (MEMFS/NODEFS only). Surface it on stderr so a misconfigured proxy isn't
    // a silent no-op (proxied file ops would then fail to open).
    try { process.stderr.write('nvim worker: proxy setup failed: ' + (e && e.message || e) + '\n'); } catch (_e) {}
  }
}

// Booting the (non-MODULARIZE) Emscripten module starts the engine. When it
// exits (e.g. :q) the worker thread exits, which the parent observes as the
// worker's 'exit' event and treats as channel EOF.
require(path.join(__dirname, 'nvim.js'));
