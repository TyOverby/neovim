// wasm/web/serve.js - Dev server for the browser build.
//
// SharedArrayBuffer requires the page to be "cross-origin isolated", which means
// every response must carry COOP + COEP headers. This tiny static server adds
// them and resolves the three kinds of asset from where they actually live:
//   * page assets (index.html, ui.js, engine-worker.js)  -> wasm/web/
//   * the SAB transport (sab.js)                          -> wasm/
//   * the msgpack UMD bundle (msgpack.min.js)             -> node_modules
//   * the wasm build artifacts (nvim.js/.wasm/.data)      -> build-wasm/bin/
//
// So you can edit the page JS and just reload — only pre.js/runtime changes need
// a rebuild.  Usage:  node wasm/web/serve.js [port]
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB = __dirname;                                   // wasm/web
const WASM = path.resolve(__dirname, '..');              // wasm
const ROOT = path.resolve(__dirname, '..', '..');        // repo root
const BUILD = path.join(ROOT, 'build-wasm', 'bin');
const MSGPACK = path.join(WEB, 'node_modules', '@msgpack', 'msgpack', 'dist.umd', 'msgpack.min.js');

const PORT = parseInt(process.argv[2] || '8000', 10);

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

function resolve(urlPath) {
  if (urlPath === '/' || urlPath === '') { return path.join(WEB, 'index.html'); }
  if (urlPath === '/nvim.js' || urlPath === '/nvim.wasm' || urlPath === '/nvim.data') {
    return path.join(BUILD, urlPath);
  }
  if (urlPath === '/sab.js') { return path.join(WASM, 'sab.js'); }
  if (urlPath === '/msgpack.min.js') { return MSGPACK; }
  // Everything else from wasm/web, but never escape it.
  const p = path.normalize(path.join(WEB, urlPath));
  return p.startsWith(WEB) ? p : null;
}

http.createServer(function (req, res) {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cache-Control', 'no-store');

  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = resolve(urlPath);
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
}).listen(PORT, function () {
  console.log('serving Neovim wasm grid UI on http://localhost:' + PORT);
  console.log('  web assets : ' + WEB);
  console.log('  wasm build : ' + BUILD);
});
