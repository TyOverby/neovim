// wasm/server/server.js - the standalone IO-proxy server (Stage 4, Phase 1).
//
// This is the SERVER half of the second transport stage 4 adds (see
// wasm/stage4.md): the browser engine worker keeps running the editor locally,
// but opens its OWN WebSocket to this server, which performs the engine's real
// IO (filesystem, child processes, PTYs -- in later phases). Phase 1 builds ONLY
// the transport + the handler-registry skeleton + the request/response protocol:
//   * ping  -> { pong:true, now:<int> }
//   * echo  -> returns params back; echoes any binary payload back too
// There is NO filesystem, NO process spawning here yet -- those are later phases.
//
// It also serves the static browser bundle over HTTP, reusing wasm/web/serve.js's
// file-serving logic verbatim (so the page and serve.js stay byte-identical), and
// adds a WebSocket endpoint at /proxy that speaks the framed proxy protocol.
//
// SECURITY (see stage4.md "Security model"): this is a remote-code-execution
// surface by design (later phases run :!, :terminal, jobstart for real). It binds
// 127.0.0.1 ONLY (loopback) and there is no token -- the single-user "edit my own
// box" model. The filesystem proxy will be jailed to --root (parsed + stored on
// ctx.config here, NOT used yet in Phase 1).
//
// DEPENDENCY: the `ws` npm package (WebSocket server). It is installed under
// wasm/web/node_modules alongside @msgpack/msgpack (the project's web-bundle dep
// location -- see wasm/build-nvim.sh, which npm-installs there). Declared in
// wasm/web/package.json.
'use strict';

const http = require('http');
const path = require('path');

// Reuse serve.js's static file-serving (resolveStaticPath / handleStaticRequest)
// so the bundle is served identically; do NOT duplicate it.
const serve = require('../web/serve.js');

// `ws` lives in wasm/web/node_modules (the web bundle's npm dep dir). Resolve it
// from there explicitly so server.js works regardless of cwd.
let WebSocketServer;
try {
  WebSocketServer = require(path.join(serve.WEB, 'node_modules', 'ws')).WebSocketServer;
} catch (e) {
  console.error('server.js: the `ws` npm package is required but not installed.');
  console.error('Install it under the web bundle:  ( cd wasm/web && npm install )');
  process.exit(1);
}

// The shared proxy-client module ALSO exports the frame codec (encodeFrame /
// decodeFrame). The server reuses those so both ends agree on the wire format.
const { encodeFrame, decodeFrame } = require('../proxy-client.js');

// Phase 2: the filesystem proxy handlers (fs.open / fs.read / fs.write / ...),
// jailed to ctx.config.root. Additive -- registered alongside the Phase 1 stubs.
const { registerFsHandlers } = require('./fs-handlers.js');

// Phase 3: the process-spawn proxy handlers (proc.spawn / proc.stdin / proc.kill
// / ...). cwd jailed to ctx.config.root; children killed when the connection drops.
const { registerProcHandlers, cleanupConnection } = require('./proc-handlers.js');

// ---- handler registry -------------------------------------------------------
// register(method, async (params, payload, ctx) => result | { result, payload }).
// A handler may return a bare result (JSON) or { result, payload } to also send
// back a binary trailer. A throw becomes a { ok:false, error } response.
function createRegistry() {
  const handlers = Object.create(null);
  function register(method, fn) { handlers[method] = fn; }
  return { handlers: handlers, register: register };
}

// Wrap a ws connection as a `transport` ({ send, close, onFrame }) and run the
// handler registry on it. ctx carries per-connection state: ctx.config (set from
// the hello handshake), ctx.push(method, params, payload) to push to this client.
function serveConnection(ws, registry, serverConfig) {
  const transport = {
    send: function (data) { ws.send(data); },
    close: function () { try { ws.close(); } catch (_e) { /* ignore */ } },
    onFrame: null,   // unused on the server side (we decode inline below)
  };

  // Per-connection context handed to every handler.
  const ctx = {
    config: { root: serverConfig.root },   // hello may overwrite/augment this
    // push an unsolicited server->client frame (used in later phases for stdout
    // chunks / process exit). No correlation id.
    push: function (method, params, payload) {
      try { transport.send(encodeFrame({ t: 'push', method: method, params: params }, payload)); }
      catch (_e) { /* connection gone */ }
    },
  };

  async function dispatch(header, payload) {
    if (header.t === 'hello') {
      // Handshake: store the client's proxy config (mount) and ack it. SECURITY:
      // the jail `root` is the SERVER's --root, authoritative -- a client-supplied
      // `root` in the hello must NOT be able to widen/relocate the jail, so we
      // force the server's root back AFTER merging the client's params.
      ctx.config = Object.assign({}, ctx.config, header.params || {});
      ctx.config.root = serverConfig.root;   // server's --root wins, always
      transport.send(encodeFrame({
        t: 'res', id: header.id, ok: true,
        result: { hello: true, config: ctx.config },
      }));
      return;
    }
    if (header.t === 'req') {
      const fn = registry.handlers[header.method];
      if (!fn) {
        transport.send(encodeFrame({
          t: 'res', id: header.id, ok: false,
          error: "unknown method '" + header.method + "'",
        }));
        return;
      }
      try {
        const ret = await fn(header.params, payload, ctx);
        // A handler may return { result, payload } or a bare result.
        let result = ret, outPayload;
        if (ret && typeof ret === 'object' && ('result' in ret || 'payload' in ret) &&
            !Array.isArray(ret)) {
          result = ret.result;
          outPayload = ret.payload;
        }
        transport.send(encodeFrame({ t: 'res', id: header.id, ok: true, result: result }, outPayload));
      } catch (err) {
        transport.send(encodeFrame({
          t: 'res', id: header.id, ok: false,
          error: (err && err.message) || String(err),
        }));
      }
      return;
    }
    // 'res' / 'push' are client-bound; ignore them inbound on the server.
  }

  ws.on('message', function (data /*, isBinary */) {
    let frame;
    try { frame = decodeFrame(data); }
    catch (_e) { return; }   // ignore undecodable noise
    dispatch(frame.header, frame.payload);
  });
  ws.on('error', function () { /* swallow; 'close' follows */ });
  // When the connection drops, kill any child processes this client spawned so a
  // closed tab/worker leaves no orphans (Phase 3). Best-effort; never throws.
  ws.on('close', function () {
    try { cleanupConnection(ctx); } catch (_e) { /* ignore */ }
  });
}

// ---- Phase 1 handlers -------------------------------------------------------
function registerPhase1Handlers(registry) {
  // ping: a liveness probe. Returns the server's wall-clock time.
  registry.register('ping', function () {
    return { pong: true, now: Date.now() };
  });
  // echo: returns params back; if a binary payload was sent, echo it back too.
  registry.register('echo', function (params, payload) {
    if (payload && payload.length) {
      return { result: params, payload: payload };
    }
    return params;
  });
}

// ---- CLI / startup ----------------------------------------------------------
function parseArgs(argv) {
  const opts = { port: 8001, root: process.cwd(), staticDir: serve.WEB };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') { opts.port = parseInt(argv[++i], 10); }
    else if (a.indexOf('--port=') === 0) { opts.port = parseInt(a.slice(7), 10); }
    else if (a === '--root') { opts.root = path.resolve(argv[++i]); }
    else if (a.indexOf('--root=') === 0) { opts.root = path.resolve(a.slice(7)); }
  }
  return opts;
}

// Build (but do not start) the HTTP + WebSocket server. Returns { httpServer,
// wss, registry, config } so tests can start it on an ephemeral port and shut it
// down cleanly. Exported for wasm/web/proxy.test.js.
function createServer(config) {
  config = config || {};
  const serverConfig = { root: config.root || process.cwd() };
  const registry = createRegistry();
  registerPhase1Handlers(registry);
  registerFsHandlers(registry);   // Phase 2: jailed filesystem proxy handlers
  registerProcHandlers(registry); // Phase 3: jailed process-spawn proxy handlers

  const httpServer = http.createServer(serve.handleStaticRequest);

  // WebSocket endpoint at /proxy. `noServer` + manual upgrade so the HTTP server
  // keeps serving the static bundle and only /proxy is upgraded.
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', function (req, socket, head) {
    const urlPath = (req.url || '').split('?')[0];
    if (urlPath !== '/proxy') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, function (ws) {
      serveConnection(ws, registry, serverConfig);
    });
  });

  return { httpServer: httpServer, wss: wss, registry: registry, config: serverConfig };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const srv = createServer({ root: opts.root });
  // Bind 127.0.0.1 ONLY -- the load-bearing security default (see stage4.md).
  srv.httpServer.listen(opts.port, '127.0.0.1', function () {
    const url = 'http://127.0.0.1:' + opts.port + '/';
    console.log('neovim.js IO-proxy server on ' + url);
    console.log('  proxies real IO (filesystem / processes / PTY) for the wasm engine');
    console.log('  proxy WebSocket : ' + url.replace('http', 'ws') + 'proxy');
    console.log('  filesystem root : ' + opts.root + '  (jail root; not yet enforced in Phase 1)');
    console.log('  bound to 127.0.0.1 only (loopback); no token (single-user model)');
    serve.warnIfBuildStale(function (m) { console.warn('  WARNING: ' + m); });
  });
}

module.exports = {
  createServer: createServer,
  createRegistry: createRegistry,
  serveConnection: serveConnection,
  registerPhase1Handlers: registerPhase1Handlers,
};

if (require.main === module) { main(); }
