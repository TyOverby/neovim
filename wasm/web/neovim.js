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
        // ASYNC SEAM: the handler may return a value OR a Promise. We always
        // await it (via Promise.resolve, so a plain synchronous return still
        // works), then reply [1, msgid, error, result]. nvim BLOCKS on
        // rpcrequest, but the engine's poll() suspends via JSPI, so an async
        // reply is fine -- the engine just waits. Without a handler we reply nil
        // (what most UIs want). A throw / rejection becomes an RPC error so the
        // engine's rpcrequest fails rather than hanging.
        var msgid = msg[1];
        var p;
        if (requestHandler) {
          try { p = Promise.resolve(requestHandler(msg[2], msg[3])); }
          catch (e) { p = Promise.reject(e); }
        } else {
          p = Promise.resolve(null);
        }
        p.then(function (result) {
          send([1, msgid, null, result === undefined ? null : result]);
        }, function (err) {
          send([1, msgid, String(err && err.message || err), null]);
        });
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

  // ---- clipboard (the first ENGINE->page call) ----------------------------
  //
  // Background: every other call goes page->engine. The clipboard is the first
  // call the ENGINE makes OF the page. When nvim yanks to the `+`/`*` register it
  // invokes its clipboard PROVIDER; we wire that provider to rpcrequest()s back at
  // this client (addressed by `instance.chan`). The client answers those requests
  // through the async onRequest seam above:
  //   * copy:  engine -> rpcrequest(chan, 'clipboard_set', lines, regtype)
  //   * paste: engine -> rpcrequest(chan, 'clipboard_get')  -> [lines, regtype]
  // nvim BLOCKS on rpcrequest, but the engine's poll() suspends via JSPI, so the
  // client's reply may be async (e.g. navigator.clipboard.readText()).
  //
  // A clipboard PROVIDER is `{ get(): Promise<string|[lines,regtype]>,
  //                            set(lines, regtype): Promise<void>|void }`.
  // `get` may return a plain string (wrapped as [string.split('\n'), 'v']) or a
  // [lines, regtype] pair; `set` receives (lines, regtype).

  // A built-in provider backed by navigator.clipboard. If navigator.clipboard is
  // absent (e.g. Node, or an insecure context) it does NOT throw at construction;
  // get()/set() reject/warn so the failure surfaces as a clear RPC error rather
  // than at install time. CAVEAT: navigator.clipboard.readText() may be denied
  // without a user gesture (paste then yields an error to nvim).
  function browserClipboardProvider() {
    function clip() {
      return (typeof navigator !== 'undefined' && navigator.clipboard) || null;
    }
    return {
      get: function () {
        var c = clip();
        if (!c || typeof c.readText !== 'function') {
          return Promise.reject(new Error('clipboard: navigator.clipboard.readText unavailable'));
        }
        return c.readText().then(function (text) {
          return [String(text == null ? '' : text).split('\n'), 'v'];
        });
      },
      set: function (lines, regtype) {
        var c = clip();
        var text = Array.isArray(lines) ? lines.join('\n') : String(lines == null ? '' : lines);
        if (!c || typeof c.writeText !== 'function') {
          if (typeof console !== 'undefined') {
            console.warn('clipboard: navigator.clipboard.writeText unavailable; copy ignored');
          }
          return Promise.resolve();
        }
        // Don't let a writeText rejection (e.g. "Document is not focused", or a
        // denied permission) propagate to nvim and error out the YANK -- the text
        // is already in nvim's register; only the mirror to the system clipboard
        // failed. Warn and resolve so editing isn't interrupted. (Paste/get does
        // propagate, so a failed read still surfaces.)
        return Promise.resolve(c.writeText(text)).catch(function (e) {
          if (typeof console !== 'undefined') {
            console.warn('clipboard: writeText failed (copy not mirrored to system clipboard):', e && e.message || e);
          }
        });
      },
    };
  }

  // Normalise a clipboard option into a provider object. Accepts:
  //   'browser'  -> the built-in navigator.clipboard provider
  //   <provider> -> a custom { get, set } object (the escape hatch / embedder hook)
  function resolveClipboardProvider(clipboard) {
    if (clipboard === 'browser') { return browserClipboardProvider(); }
    if (clipboard && typeof clipboard.get === 'function' && typeof clipboard.set === 'function') {
      return clipboard;
    }
    throw new Error("clipboard option must be 'browser' or a { get, set } provider");
  }

  // enableClipboard(instance, provider) -- wire `provider` as the instance's
  // clipboard. Reusable + unit-testable; exported as Neovim.enableClipboard for
  // embedders driving createNvim() directly. Must be called AFTER the instance is
  // ready (so instance.chan exists). It:
  //   a. installs an onRequest handler that routes 'clipboard_get'/'clipboard_set'
  //      to the provider and DELEGATES every other method to a caller-supplied
  //      onRequest (if any) -- it never silently clobbers a user's handler;
  //   b. sets g:clipboard in the engine so nvim's clipboard provider calls back
  //      via rpcrequest(<instance.chan>, 'clipboard_get'/'clipboard_set', ...);
  //   c. sets `clipboard=unnamedplus` so plain y/p/d use the system clipboard
  //      (pass setRegister=false to wire only the explicit "+/"* registers).
  // Returns a Promise that resolves once g:clipboard is installed.
  function enableClipboard(instance, provider, prevRequestHandler, setRegister) {
    if (instance.chan == null) {
      throw new Error('enableClipboard: instance has no RPC channel yet (await instance.ready)');
    }
    // Compose: clipboard methods first, then delegate to the prior handler.
    instance.onRequest(function (method, params) {
      params = params || [];
      if (method === 'clipboard_get') {
        return Promise.resolve(provider.get()).then(function (res) {
          // Accept a plain string (wrap as [lines, 'v']) or a [lines, regtype] pair.
          if (typeof res === 'string') { return [res.split('\n'), 'v']; }
          if (Array.isArray(res) && Array.isArray(res[0])) { return res; }
          if (Array.isArray(res)) { return [res, 'v']; }   // a bare lines array
          return [[''], 'v'];
        });
      }
      if (method === 'clipboard_set') {
        // params: [lines, regtype, reg] -- nvim passes the lines list and regtype.
        return Promise.resolve(provider.set(params[0], params[1]));
      }
      if (typeof prevRequestHandler === 'function') {
        return prevRequestHandler(method, params);
      }
      return null;   // unknown method, no delegate -> reply nil (as default)
    });

    // Install g:clipboard with Lua function entries that rpcrequest() back at us.
    // nvim's provider (runtime/autoload/provider/clipboard.vim) accepts a
    // g:clipboard dict whose copy/paste '+'/'*' entries are FUNCREFS (it checks
    // `type(...) == v:t_func`). A Lua function assigned via vim.g.clipboard
    // becomes a v:t_func funcref, so the provider calls it directly:
    //   paste: s:paste[reg]()           -> our get  -> returns [lines, regtype]
    //   copy:  s:copy[reg](lines, type) -> our set
    // We force-reload the provider (unlet g:loaded_clipboard_provider + re-source)
    // so it re-reads g:clipboard even if it was evaluated during startup.
    var chan = instance.chan;
    var lua =
      'local chan = ...\n' +
      'local function paste(reg)\n' +
      '  return function()\n' +
      '    return vim.rpcrequest(chan, "clipboard_get", reg)\n' +
      '  end\n' +
      'end\n' +
      'local function copy(reg)\n' +
      '  return function(lines, regtype)\n' +
      '    vim.rpcrequest(chan, "clipboard_set", lines, regtype, reg)\n' +
      '  end\n' +
      'end\n' +
      'vim.g.clipboard = {\n' +
      '  name = "neovim-wasm",\n' +
      '  copy = { ["+"] = copy("+"), ["*"] = copy("*") },\n' +
      '  paste = { ["+"] = paste("+"), ["*"] = paste("*") },\n' +
      '  cache_enabled = 0,\n' +
      '}\n' +
      // Re-source the provider so g:loaded_clipboard_provider re-evaluates against
      // the new g:clipboard (it may have been 0 from a headless boot with no tool).
      'pcall(function() vim.g.loaded_clipboard_provider = nil end)\n' +
      'vim.cmd("runtime autoload/provider/clipboard.vim")\n' +
      // Route the UNNAMED register through the clipboard so plain y/p/d "just
      // work" with the system clipboard -- without this, only the explicit "+/"*
      // registers ("+p etc.) touch it, which surprises most users. Skipped when
      // setRegister is false (an embedder who wants only the +/* registers).
      (setRegister === false ? '' : 'pcall(function() vim.o.clipboard = "unnamedplus" end)\n');
    return instance.request('nvim_exec_lua', [lua, [chan]]);
  }

  // Browser convenience: spawn the engine in a Web Worker (engine-worker.js) and
  // wrap it as a transport. `config` is the engine init payload sent as the
  // worker's first message: { args, env, cwd, filesystem }. `args` are the nvim
  // args (without `--embed`, which the worker prepends); env/cwd/filesystem are
  // the optional create() runtime config that engine-worker.js forwards to pre.js
  // via the __nvim* globals. Only valid in a browser/worker context (uses Worker).
  //
  // Back-compat: a bare array may be passed in place of `config` (legacy
  // `browserEngineTransport(url, args)` callers) -- it is treated as `{ args }`.
  function browserEngineTransport(engineUrl, config) {
    if (Array.isArray(config)) { config = { args: config }; }
    config = config || {};
    var init = {
      args: config.args || [],
      env: config.env,
      cwd: config.cwd,
      filesystem: config.filesystem,
      // Runtime bundle variant. engine-worker.js loads nvim-<plugins>.data.js
      // before nvim.js. Default 'full'.
      plugins: config.plugins,
      // Optional Stage 4 IO-proxy config ({ url, root, mount }). When present,
      // engine-worker.js opens a WebSocket to the server and wires the proxy
      // client; when absent it opens no connection (additive/opt-in).
      proxy: config.proxy,
    };
    var worker = new Worker(engineUrl);
    var t = {
      onMessage: null,
      onClose: null,
      onStatus: null,
      send: function (u8) { worker.postMessage(u8.buffer, [u8.buffer]); },
      start: function () { worker.postMessage(init); },
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
  // instance over it.
  //   opts: { args, baseUrl, engineUrl, transport, MessagePack,
  //           env, cwd, filesystem, plugins }
  // `plugins` selects the runtime bundle ('full' (default) | 'core' | 'minimal');
  // all share one nvim.wasm and differ only in which nvim-<variant>.data the
  // engine worker loads. It is validated here and only applies on the default
  // browser worker path (with a caller-supplied `transport` it has no effect).
  // env/cwd/filesystem are the runtime config (see wasm/README.md): they are
  // carried in the engine worker's init message and applied by pre.js before the
  // engine's main() runs. With a caller-supplied `transport` they have no effect
  // (the transport owns the engine handshake), so they only apply on the default
  // browser path.
  //
  // RETURN SHAPE -- a "promise-facade": create() returns a real Promise that
  // FULFILLS WITH THE (distinct) ready instance, so `await Neovim.create(...)`
  // yields a fully-usable instance. The same object ALSO carries the instance's
  // synchronous members forwarded onto it (request/notify/input/onNotification/
  // onStatus/onRequest/dispose/ready and a `chan` getter), so the existing
  // synchronous usage (app.js: subscribe onStatus, mount_into, then `.ready`)
  // keeps working WITHOUT awaiting.
  //
  // CORRECTNESS: a Promise can never fulfill with itself (the Promise resolution
  // procedure would deadlock). So the facade must fulfill with the *instance*,
  // which is a DISTINCT, non-thenable object -- NOT with the facade. We therefore
  // build the facade from `instance.ready` (which already fulfills with the
  // instance) and never make the instance itself thenable. createNvim() stays a
  // plain synchronous instance and is intentionally NOT wrapped.
  // Runtime bundle variants (the `plugins` option). nvim.wasm is shared across
  // all of them; each is a different (nvim-<variant>.data + loader) pair:
  //   full    - the complete runtime (default).
  //   core    - trimmed: boot + edit + filetype/indent + a curated syntax slice.
  //   minimal - strictly the boot/edit essentials (no syntax/ftplugin/doc).
  var PLUGIN_VARIANTS = { full: 1, core: 1, minimal: 1 };

  // Validate the optional Stage 4 `proxy` config (the standalone-app IO proxy --
  // see wasm/stage4.md). It is ADDITIVE and OPT-IN: absent => behave exactly as
  // today (no server connection). Shape: { url:<string>, root?:<string>,
  // mount?:<string> }. Throw a clear error on a bad shape, mirroring the
  // `plugins` validation. Returns the (possibly normalized) proxy config or null.
  function validateProxy(proxy) {
    if (proxy == null) { return null; }
    if (typeof proxy !== 'object') {
      throw new Error('Neovim.create: proxy must be an object { url, root?, mount? }');
    }
    if (typeof proxy.url !== 'string' || !proxy.url) {
      throw new Error("Neovim.create: proxy.url (the server WebSocket URL) is required and must be a string");
    }
    if (proxy.root != null && typeof proxy.root !== 'string') {
      throw new Error('Neovim.create: proxy.root must be a string (the server-side jail root)');
    }
    if (proxy.mount != null && typeof proxy.mount !== 'string') {
      throw new Error('Neovim.create: proxy.mount must be a string (the in-engine mount prefix)');
    }
    // nvimSocket (optional): the server-side path for nvim's RPC socket ($NVIM),
    // forwarded to the worker so it can be sent in the hello — the server then
    // exports $NVIM to spawned children so they can drive nvim over RPC.
    if (proxy.nvimSocket != null && typeof proxy.nvimSocket !== 'string') {
      throw new Error('Neovim.create: proxy.nvimSocket must be a string (the server-side RPC socket path)');
    }
    return { url: proxy.url, root: proxy.root, mount: proxy.mount, nvimSocket: proxy.nvimSocket };
  }

  function create(opts) {
    opts = opts || {};
    // Validate `plugins` up front so a typo fails loudly here, not after the
    // worker silently 404s on a missing nvim-<typo>.data.js.
    if (opts.plugins != null && !PLUGIN_VARIANTS[opts.plugins]) {
      throw new Error("Neovim.create: unknown plugins variant '" + opts.plugins +
        "' (expected 'full', 'core', or 'minimal')");
    }
    // Validate the optional Stage 4 proxy config (opt-in; absent => unchanged).
    var proxy = validateProxy(opts.proxy);
    var transport = opts.transport ||
      browserEngineTransport(resolveEngineUrl(opts), {
        args: opts.args || [],
        env: opts.env,
        cwd: opts.cwd,
        filesystem: opts.filesystem,
        plugins: opts.plugins,
        // Threaded into the engine-worker init message as init.proxy. When absent
        // engine-worker.js opens NO server connection (current behavior).
        proxy: proxy,
      });
    var instance = createNvim({ transport: transport, MessagePack: opts.MessagePack });

    // Clipboard: if requested, resolve the provider up front (so a bad option
    // throws synchronously from create()), then install it after the instance is
    // ready. We compose with any onRequest the caller sets on the facade BEFORE
    // we install (clipboard methods first, then delegate), so we never clobber a
    // user handler. Track the last user-set onRequest here.
    var userRequestHandler = null;
    var clipboardProvider = (opts.clipboard != null)
      ? resolveClipboardProvider(opts.clipboard) : null;

    // A real Promise fulfilling with the DISTINCT instance once it's ready, after
    // the clipboard (if any) is wired so an awaiter gets a clipboard-ready
    // instance. A clipboard install failure is surfaced as a status, not a reject,
    // so the editor is still usable without clipboard.
    var facade = instance.ready.then(function () {
      if (!clipboardProvider) { return instance; }
      return enableClipboard(instance, clipboardProvider, userRequestHandler)
        .then(function () { return instance; }, function (err) {
          if (typeof console !== 'undefined') {
            console.warn('clipboard: failed to install g:clipboard:', err);
          }
          return instance;
        });
    });

    // Forward the instance's synchronous surface onto the facade so callers who
    // don't await still get the instance API directly off the create() result.
    ['request', 'notify', 'input', 'onNotification', 'onStatus',
     'dispose'].forEach(function (m) {
      facade[m] = function () { return instance[m].apply(instance, arguments); };
    });
    // onRequest is intercepted so the clipboard install can compose with (rather
    // than clobber) a user-supplied handler regardless of call order. If clipboard
    // is already installed, re-install so the new user handler is the delegate.
    facade.onRequest = function (fn) {
      userRequestHandler = fn;
      if (clipboardProvider && instance.chan != null) {
        enableClipboard(instance, clipboardProvider, userRequestHandler);
      } else if (!clipboardProvider) {
        instance.onRequest(fn);
      }
      // else: clipboard requested but not ready yet -- the facade's ready handler
      // above installs it with this userRequestHandler as the delegate.
    };
    facade.ready = instance.ready;
    // `chan` is set asynchronously on the instance once ready; expose it live.
    Object.defineProperty(facade, 'chan', {
      enumerable: true,
      get: function () { return instance.chan; },
    });
    return facade;
  }

  return {
    create: create,
    createNvim: createNvim,
    enableClipboard: enableClipboard,
    browserEngineTransport: browserEngineTransport,
    resolveEngineUrl: resolveEngineUrl,
    ByteQueue: ByteQueue,
  };
});
