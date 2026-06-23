// wasm/web/neovim.js - headless Neovim instance (msgpack-RPC core).
//
// The "core API" layer of the browser port (see wasm/README.md). It owns ONLY
// the msgpack-RPC conversation with an `nvim --embed` engine; it has no DOM, no
// grid, and no knowledge of how the engine worker is hosted. Rendering lives in
// neovim-ui.js; the page wiring lives in app.js.
//
// An instance talks to the engine through a *transport* -- a thin byte channel
// the caller supplies. This is what keeps the core environment-agnostic and
// testable: the browser drives the engine in a Web Worker (engine-worker.js),
// while the headless Node test (e2e.test.js) drives it in a worker_thread
// (wasm/worker.js). Both look identical to the core.
//
//   transport = {
//     send(u8),            // hand RPC bytes to the engine (transfers u8.buffer)
//     start(),             // optional: called once before any send (e.g. the
//                          //   browser worker's {args} init message)
//     close(),             // optional: tear the engine down
//     onMessage,           // WE set this; transport calls it with each RPC byte
//                          //   chunk from the engine (a Uint8Array)
//     onClose,             // WE set this; transport calls it when the engine
//                          //   exits / the channel closes
//     onStatus,            // WE set this (optional); transport calls it with
//                          //   out-of-band {kind,...} status objects
//   }
//
// UMD: usable as a <script> (exposes globalThis.Neovim) or via require() in Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.Neovim = factory(); }
})(typeof self !== 'undefined' ? self
   : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // A tiny async-iterable byte queue: the transport pushes RPC chunks in,
  // @msgpack/msgpack's decodeMultiStream pulls whole values out (handling
  // msgpack messages split across postMessage boundaries).
  function ByteQueue() { this._items = []; this._waiters = []; this._done = false; }
  ByteQueue.prototype.push = function (u8) {
    if (this._waiters.length) { this._waiters.shift()({ value: u8, done: false }); }
    else { this._items.push(u8); }
  };
  ByteQueue.prototype.close = function () {
    this._done = true;
    while (this._waiters.length) { this._waiters.shift()({ value: undefined, done: true }); }
  };
  ByteQueue.prototype[Symbol.asyncIterator] = function () {
    var self = this;
    return {
      next: function () {
        if (self._items.length) { return Promise.resolve({ value: self._items.shift(), done: false }); }
        if (self._done) { return Promise.resolve({ value: undefined, done: true }); }
        return new Promise(function (res) { self._waiters.push(res); });
      },
    };
  };

  // Create a headless Neovim instance over `transport`. `MessagePack` is the
  // @msgpack/msgpack module ({encode, decodeMultiStream}); it defaults to the
  // UMD global when present (browser). Returns the instance immediately; its
  // `.ready` promise resolves once the engine answers nvim_get_api_info (which
  // also populates `.chan`).
  function createNvim(opts) {
    opts = opts || {};
    var transport = opts.transport;
    if (!transport) { throw new Error('createNvim: opts.transport is required'); }
    var MP = opts.MessagePack || (typeof MessagePack !== 'undefined' ? MessagePack : null);
    if (!MP) { throw new Error('createNvim: MessagePack (@msgpack/msgpack) not provided'); }

    var nextMsgId = 1;
    var pending = {};                 // msgid -> {resolve, reject}
    var notifyHandlers = {};          // method -> [fn(params)]
    var statusHandlers = [];          // [fn(status)]
    var requestHandler = null;        // optional fn(method, params) -> reply value
    var inbox = new ByteQueue();
    var closed = false;

    function send(value) {
      // Standalone copy so the buffer can be transferred (zero-copy clone).
      var u8 = MP.encode(value).slice();
      transport.send(u8);
    }
    function request(method, params) {
      var id = nextMsgId++;
      var p = new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
      send([0, id, method, params || []]);
      return p;
    }
    function notify(method, params) { send([2, method, params || []]); }

    function onMessage(msg) {
      if (!Array.isArray(msg)) { return; }
      var type = msg[0];
      if (type === 1) {                       // response: [1, msgid, error, result]
        var h = pending[msg[1]];
        if (h) { delete pending[msg[1]]; if (msg[2]) { h.reject(msg[2]); } else { h.resolve(msg[3]); } }
      } else if (type === 2) {                // notification: [2, method, params]
        var hs = notifyHandlers[msg[1]];
        if (hs) { for (var i = 0; i < hs.length; i++) { hs[i](msg[2]); } }
      } else if (type === 0) {                // request from engine: [0, msgid, method, params]
        var result = null;
        if (requestHandler) { try { result = requestHandler(msg[2], msg[3]); } catch (e) { /* reply nil */ } }
        send([1, msg[1], null, result]);
      }
    }

    function emitStatus(s) { for (var i = 0; i < statusHandlers.length; i++) { statusHandlers[i](s); } }

    transport.onMessage = function (u8) { inbox.push(u8); };
    transport.onClose = function () { closeInstance(); };
    transport.onStatus = emitStatus;

    function closeInstance() {
      if (closed) { return; }
      closed = true;
      inbox.close();
      emitStatus({ kind: 'exit' });
      // Reject any in-flight requests so callers don't hang forever.
      for (var id in pending) {
        if (Object.prototype.hasOwnProperty.call(pending, id)) {
          pending[id].reject(new Error('engine closed'));
          delete pending[id];
        }
      }
    }

    async function receiveLoop() {
      try {
        for await (var msg of MP.decodeMultiStream(inbox)) { onMessage(msg); }
      } catch (err) {
        emitStatus({ kind: 'error', error: String(err && err.stack || err) });
      }
    }

    var instance = {
      request: request,
      notify: notify,
      // Convenience: feed raw key input to the engine.
      input: function (keys) { return notify('nvim_input', [keys]); },
      // Subscribe to a notification method (e.g. 'redraw'). Returns an unsubscribe fn.
      onNotification: function (method, fn) {
        (notifyHandlers[method] || (notifyHandlers[method] = [])).push(fn);
        return function () {
          var hs = notifyHandlers[method];
          if (!hs) { return; }
          var idx = hs.indexOf(fn);
          if (idx !== -1) { hs.splice(idx, 1); }
        };
      },
      // Subscribe to out-of-band transport status ({kind:'booting'|'stdout'|
      // 'stderr'|'exit'|'error', ...}). Returns an unsubscribe fn.
      onStatus: function (fn) {
        statusHandlers.push(fn);
        return function () { var i = statusHandlers.indexOf(fn); if (i !== -1) { statusHandlers.splice(i, 1); } };
      },
      // Handle requests the engine makes of the client (rare). fn(method, params)
      // -> reply value. Without one we reply nil, which is what most UIs want.
      onRequest: function (fn) { requestHandler = fn; },
      chan: null,         // this client's RPC channel id (set once ready)
      dispose: function () { try { if (transport.close) { transport.close(); } } finally { closeInstance(); } },
    };

    receiveLoop();
    if (transport.start) { transport.start(); }

    // Round-trip one request so callers can `await nvim.ready`, and learn our
    // channel id (needed to address rpcnotify() back at us). This also proves
    // the engine booted and the transport works end to end.
    instance.ready = request('nvim_get_api_info').then(function (info) {
      instance.chan = Array.isArray(info) ? info[0] : null;
      return instance;
    });

    return instance;
  }

  // Browser convenience: spawn the engine in a Web Worker (engine-worker.js) and
  // wrap it as a transport. `args` are the nvim args (without `--embed`, which
  // the worker prepends). Only valid in a browser/worker context (uses Worker).
  function browserEngineTransport(engineUrl, args) {
    var worker = new Worker(engineUrl);
    var t = {
      onMessage: null,
      onClose: null,
      onStatus: null,
      send: function (u8) { worker.postMessage(u8.buffer, [u8.buffer]); },
      start: function () { worker.postMessage({ args: args || [] }); },
      close: function () { worker.terminate(); },
    };
    worker.onmessage = function (e) {
      var d = e.data;
      if (d instanceof ArrayBuffer) { if (t.onMessage) { t.onMessage(new Uint8Array(d)); } return; }
      if (d && d.kind === 'exit') { if (t.onClose) { t.onClose(); } return; }
      if (t.onStatus) { t.onStatus(d); }
    };
    worker.onerror = function (e) {
      if (t.onStatus) { t.onStatus({ kind: 'error', error: e.message || (e.filename + ':' + e.lineno) }); }
    };
    return t;
  }

  // Resolve the engine-worker URL from opts. Precedence:
  //   1. opts.engineUrl  (explicit override; used verbatim)
  //   2. opts.baseUrl + 'engine-worker.js'  (host the bundle anywhere)
  //   3. 'engine-worker.js'  (relative to the page, the original behaviour)
  // `baseUrl` accepts a value with or without a trailing slash.
  //
  // How the rest of the asset chain resolves once engine-worker.js is loaded
  // from `baseUrl` (verified by hosting the bundle from a subpath and curling
  // the asset URLs, see wasm/web/build-lib.sh):
  //   * The worker does `importScripts('nvim.js')`, which resolves RELATIVE to
  //     the worker's own URL -- i.e. relative to `baseUrl`. So nvim.js loads
  //     from baseUrl/nvim.js with no extra plumbing.
  //   * Emscripten's browser `locateFile` then resolves nvim.wasm / nvim.data
  //     relative to the script that loaded it (nvim.js, itself under baseUrl),
  //     so those land under baseUrl too.
  // The whole chain therefore follows `baseUrl` automatically; nothing needs to
  // be threaded into the worker. CAVEAT: `new Worker(url)` requires a SAME-ORIGIN
  // url, so `baseUrl` may point at a subpath of the page's origin but not at a
  // different-origin CDN. Cross-origin hosting needs a Blob-bootstrap shim, which
  // is intentionally out of scope here (see wasm/README.md).
  function resolveEngineUrl(opts) {
    if (opts.engineUrl) { return opts.engineUrl; }
    if (opts.baseUrl) {
      var base = opts.baseUrl;
      if (base.charAt(base.length - 1) !== '/') { base += '/'; }
      return base + 'engine-worker.js';
    }
    return 'engine-worker.js';
  }

  // The README-facing entry point: build a browser engine transport and a core
  // instance over it. opts: { args, baseUrl, engineUrl }.
  function create(opts) {
    opts = opts || {};
    var transport = opts.transport ||
      browserEngineTransport(resolveEngineUrl(opts), opts.args || []);
    return createNvim({ transport: transport, MessagePack: opts.MessagePack });
  }

  return {
    create: create,
    createNvim: createNvim,
    browserEngineTransport: browserEngineTransport,
    resolveEngineUrl: resolveEngineUrl,
    ByteQueue: ByteQueue,
  };
});
