// wasm/web/app.js - page wiring for the browser demo.
//
// This is the thin glue an embedder would write: it composes the two library
// layers -- the headless core (neovim.js) and the default renderer
// (neovim-ui.js) -- into the page. All the reusable logic lives in those two
// modules; this file only knows about *this* page's DOM and status line.
'use strict';

(function () {
  var statusEl = document.getElementById('status');
  var screenEl = document.getElementById('screen');
  function setStatus(s) { if (statusEl) { statusEl.textContent = s; } }

  setStatus('starting engine worker…');

  // Stage 4 (standalone app, opt-in): when this page is served BY
  // `rvim --proxy`, /proxy-config.js has set window.__NVIM_PROXY =
  // { url, mount, root }. We pass it to create({ proxy }) so the engine's real IO
  // (filesystem under the mount prefix, :!, jobstart, :terminal, LSP) runs on the
  // server, jailed to its --root. When it's ABSENT (the plain serve.js static
  // demo, or the library used without a proxy) we behave EXACTLY as before --
  // no server connection, MEMFS-only. The mechanism is documented in index.html.
  var proxy = (typeof window.__NVIM_PROXY === 'object' && window.__NVIM_PROXY) || null;
  var mount = (proxy && typeof proxy.mount === 'string' && proxy.mount) || '/host';

  // 1. Core: boot `nvim --embed` in a Web Worker and speak msgpack-RPC to it.
  //    clipboard: 'browser' wires the +/* registers (and, via unnamedplus, plain
  //    y/p/d) to the system clipboard through navigator.clipboard. Pasting may
  //    prompt for clipboard-read permission the first time; needs a secure context
  //    (HTTPS or localhost). When `proxy` is present it is threaded through; when
  //    null, create() ignores it and the no-proxy path is byte-for-byte unchanged.
  var nvim = Neovim.create({ args: [ '-n' ], clipboard: 'browser', proxy: proxy });

  // Track proxy connection state so we can reflect it in the status line. The
  // engine worker posts {kind:'stdout', text:'proxy: connected to ...'} on success
  // and {kind:'stderr', text:'proxy: ...'} on failure (see engine-worker.js).
  var proxyState = proxy ? 'connecting' : null;

  // Standalone-app RPC host: once nvim is ready AND the proxy is connected, start
  // nvim's RPC server on the SERVER-side socket the server suggested
  // (proxy.nvimSocket) and export $NVIM, so child processes / :terminal spawned on
  // the server inherit $NVIM and can drive this nvim over msgpack-RPC — exactly
  // like a normal nvim host. The socket lives on the server (the proxy binds unix
  // paths there), so the path is valid for server-side children; the connection's
  // cleanup removes it on disconnect. Runs once. We can't do this at nvim startup:
  // the proxy connects asynchronously after boot, so an early serverstart fails.
  var nvimReady = false;
  var rpcServerStarted = false;
  function maybeStartRpcServer() {
    if (rpcServerStarted || !nvimReady || proxyState !== 'connected') { return; }
    if (!proxy || !proxy.nvimSocket) { return; }
    rpcServerStarted = true;
    // On a RECONNECT the previous listener is dead (the server tore it down when the
    // transport dropped), but nvim still holds it as v:servername — so stop it
    // (best-effort) before starting a fresh one on the SAME path. Reusing the path
    // keeps $NVIM stable: the server re-injects it from the unchanged hello, so
    // children keep pointing at a live socket. rpcServerStarted is reset on each
    // disconnect (below) so this re-runs after reconnect.
    nvim.request('nvim_exec_lua', [
      'local p = ...\n' +
      'pcall(function() if vim.v.servername ~= "" then vim.fn.serverstop(vim.v.servername) end end)\n' +
      'local a = vim.fn.serverstart(p)\n' +
      'vim.env.NVIM = a\n' +
      'return a',
      [ proxy.nvimSocket ]
    ]).then(function (addr) {
      console.log('[rvim] nvim RPC server on ' + addr + ' — $NVIM exported to child processes');
    }, function (err) {
      console.warn('[rvim] serverstart failed: ' + (err && err.message || err));
    });
  }

  nvim.onStatus(function (s) {
    if (!s) { return; }
    if (s.kind === 'booting') { setStatus('engine booting (loading wasm + runtime)…'); }
    else if (s.kind === 'stdout' || s.kind === 'stderr') {
      console.log('[engine ' + s.kind + ']', s.text);
      // Reflect proxy connection state in the status line (engine-worker emits
      // these proxy:* lines around the WebSocket handshake).
      if (proxy && typeof s.text === 'string' && s.text.indexOf('proxy:') === 0) {
        if (/^proxy: connected/.test(s.text)) { proxyState = 'connected'; maybeStartRpcServer(); }
        else { proxyState = 'error'; rpcServerStarted = false; }  // reset so reconnect re-establishes the RPC server
        refreshStatus();
      }
    }
    else if (s.kind === 'exit') { setStatus('engine exited'); }
    else if (s.kind === 'error') { console.error('engine error', s.error); setStatus('engine error: ' + s.error); }
  });

  // Compose the attached/ready status with the proxy connection state (if any).
  var readyMsg = '';
  function refreshStatus() {
    if (!readyMsg) { return; }   // only after ready; pre-ready status is owned above
    var suffix = '';
    if (proxy) {
      if (proxyState === 'connected') { suffix = ' — proxy connected (' + proxy.url + ', files at ' + mount + ')'; }
      else if (proxyState === 'error') { suffix = ' — proxy NOT connected (' + proxy.url + '); IO stays local'; }
      else { suffix = ' — connecting to proxy ' + proxy.url + '…'; }
    }
    setStatus(readyMsg + suffix);
  }

  // 2. Renderer: mount a default grid UI into the <pre> and forward keystrokes.
  //    No fixed cols/rows -> mount_into auto-sizes the grid to fill #screen and
  //    tracks its size (drag the resize handle / resize the window to reflow).
  //    font_family / font_size are applied to the element (and pin a stable
  //    line-height for the grid math).
  var ui = NeovimUI.mount_into(nvim, screenEl, {
    font_family: 'ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace',
    font_size: 16,
  });

  nvim.ready
    .then(function () {
      readyMsg = 'attached — click the grid and type (chan ' + nvim.chan + ')';
      nvimReady = true;
      maybeStartRpcServer();   // proxy may have connected before nvim was ready
      // refreshStatus() composes readyMsg with the current proxyState (the
      // proxy:connected/error status may have arrived before or after ready).
      refreshStatus();
      // Standalone-app path: land the user in the SERVER's files. chdir into the
      // mount and open it so the first thing they see is the server's project
      // directory (the mount '/host' maps to the server's --root). Best-effort:
      // if the proxy isn't actually connected the cd/edit fails soft and the user
      // is simply left in the local MEMFS cwd. No effect on the no-proxy demo.
      if (proxy) {
        nvim.request('nvim_cmd', [{ cmd: 'cd', args: [ mount ] }, {}]).catch(function () {});
        nvim.request('nvim_cmd', [{ cmd: 'edit', args: [ mount ] }, {}]).catch(function () {});
      }
    })
    .catch(function (err) { setStatus('failed to start: ' + (err && err.message || err)); });

  // 3. Expose a tiny API for debugging / automated testing (unchanged surface).
  window.nvim = {
    input: function (keys) { return nvim.input(keys); },
    request: function (method, params) { return nvim.request(method, params); },
    resize: function (c, r) { return ui.resize(c, r); },
    gridText: function () { return ui.screen.text(); },
    cursor: ui.screen.cursor,
    state: function () { return { cols: ui.screen.cols, rows: ui.screen.rows, cursor: ui.screen.cursor }; },
  };
})();
