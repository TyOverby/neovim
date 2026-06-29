// wasm/web/serve.js - Plain static dev server for the browser build.
//
// The transport is postMessage (not SharedArrayBuffer), so the page needs NO
// special headers — this is a plain static server, the same as any host would
// be. It just resolves the kinds of asset from where they live in the tree:
//   * page + library (index.html, neovim.js, neovim-ui.js, app.js,
//     engine-worker.js)                                   -> wasm/web/
//   * the msgpack UMD bundle (msgpack.min.js)             -> node_modules
//   * the wasm build artifacts (nvim.js/.wasm/.data)      -> build-wasm/bin/
//   * the proxy client (proxy-client.js, proxy-reconnect.js), which the engine
//     worker importScripts at runtime                     -> wasm/
//
// So you can edit the page JS and just reload — only pre.js/runtime changes need
// a rebuild. The standalone-app server is the Go `rvim` binary (wasm/rvim/); this
// is just the no-proxy dev server.  Usage:  node wasm/web/serve.js [port]
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB = __dirname;                                   // wasm/web
const WASM = path.resolve(__dirname, '..');              // wasm
const ROOT = path.resolve(__dirname, '..', '..');        // repo root
const BUILD = path.join(ROOT, 'build-wasm', 'bin');
const MSGPACK = path.join(WEB, 'node_modules', '@msgpack', 'msgpack', 'dist.umd', 'msgpack.min.js');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.json': 'application/json',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
};

// Map a request URL path to a file on disk (or null to forbid): page + library
// from wasm/web, engine assets from build-wasm/bin, and the proxy client from
// wasm/ (the engine worker importScripts it relative to its own URL).
function resolveStaticPath(urlPath) {
  if (urlPath === '/' || urlPath === '') { return path.join(WEB, 'index.html'); }
  // Engine assets live in build-wasm/bin: nvim.js/.wasm and the per-variant
  // runtime packages nvim-<variant>.data + nvim-<variant>.data.js (loaders).
  if (urlPath === '/nvim.js' || urlPath === '/nvim.wasm' ||
      /^\/nvim(-(full|core|minimal))?\.data(\.js)?$/.test(urlPath)) {
    return path.join(BUILD, urlPath);
  }
  if (urlPath === '/msgpack.min.js') { return MSGPACK; }
  // The proxy client + reconnect facade live one dir up (wasm/), not in wasm/web;
  // the engine worker importScripts them relative to its own URL, so they must
  // resolve at the bundle root.
  if (urlPath === '/proxy-client.js') { return path.join(WASM, 'proxy-client.js'); }
  if (urlPath === '/proxy-reconnect.js') { return path.join(WASM, 'proxy-reconnect.js'); }
  // Everything else from wasm/web, but never escape it.
  const p = path.normalize(path.join(WEB, urlPath));
  return p.startsWith(WEB) ? p : null;
}

function serveStaticFile(file, urlPath, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!file) { res.statusCode = 403; res.end('forbidden'); return; }
  fs.readFile(file, function (err, data) {
    if (err) {
      res.statusCode = 404;
      res.end('not found: ' + urlPath);
      return;
    }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
}

function handleRequest(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  // The page unconditionally loads /proxy-config.js (the standalone-app hook):
  // the `rvim --proxy` Go server GENERATES it with the real proxy config so
  // visiting that server is the standalone app. This plain static dev server has
  // NO proxy, so serve a no-op 200 (not a 404) — the page then runs as the
  // ordinary no-proxy demo (window.__NVIM_PROXY stays undefined).
  if (urlPath === '/proxy-config.js') {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.end('// no proxy: the plain static dev server (serve.js) runs the no-proxy demo.\n');
    return;
  }
  serveStaticFile(resolveStaticPath(urlPath), urlPath, res);
}

// Warn early if the wasm build is stale (the page needs nvim.js + a runtime data
// package).
function warnIfBuildStale() {
  const missing = ['nvim.js', 'nvim.wasm', 'nvim-full.data.js', 'nvim-full.data']
    .filter(function (f) { return !fs.existsSync(path.join(BUILD, f)); });
  if (missing.length) {
    console.warn('  WARNING: missing in ' + BUILD + ': ' + missing.join(', '));
    console.warn('  WARNING: Run wasm/build-nvim.sh to (re)build the engine + runtime data packages.');
  }
}

const PORT = parseInt(process.argv[2] || '8000', 10);
http.createServer(handleRequest).listen(PORT, function () {
  console.log('serving Neovim wasm grid UI on http://localhost:' + PORT);
  console.log('  web assets : ' + WEB);
  console.log('  wasm build : ' + BUILD);
  warnIfBuildStale();
});
