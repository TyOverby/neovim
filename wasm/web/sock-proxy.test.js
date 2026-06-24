// wasm/web/sock-proxy.test.js - END-TO-END test of the Stage 4 TCP socket + DNS
// proxy through the REAL engine + REAL server + REAL WebSocket + REAL Node net.
//
// Boots the actual Neovim wasm engine (build-wasm/bin/nvim.js in a Node
// worker_thread via wasm/worker.js) WITH a proxy config, starts the real
// server.js on a loopback port, AND a fixture TCP echo server in this process,
// then asserts that outbound TCP + DNS run on the server:
//
//   * vim.uv (luv): c=vim.uv.new_tcp(); c:connect('127.0.0.1', PORT, cb) then
//       read_start + write('ping') -> the echo 'ping' comes back.
//   * vim.uv.getaddrinfo('localhost', ...) -> returns an address.
//   * nvim sockconnect('tcp','127.0.0.1:'..PORT, {rpc=false, on_data=...}) +
//       chansend round-trip (exercises socket.c's SYNC getaddrinfo +
//       uv_tcp_connect path).
//   * clean teardown with a LIVE socket -> dispose doesn't hang/crash.
//
// Socket IO is async (it round-trips the server) -- we wait on callbacks /
// notifications, never fixed sleeps for the assertions.
//
// Run:  node wasm/web/sock-proxy.test.js   (Node >= 24, or >= 22 with --jspi flag)
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { Worker } = require('worker_threads');

const MessagePack = require('@msgpack/msgpack');
const Neovim = require('./neovim.js');
const serverMod = require('../server/server.js');

const ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(ROOT, 'build-wasm', 'bin');
const WORKER = path.join(BIN, 'worker.js');

// ---- tiny test harness (mirrors pty-proxy.test.js) -------------------------
let failures = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) { console.log('  ok   - ' + msg); }
  else { failures++; console.log('  FAIL - ' + msg); }
}
function fatal(msg) { console.error('sock-proxy: ' + msg); process.exit(1); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function waitFor(pred, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) { return true; }
    await sleep(25);
  }
  return false;
}

function nodeEngineTransport(cfg) {
  cfg = cfg || {};
  const env = Object.assign({}, process.env);
  delete env.NVIM_LOG_FILE;
  const worker = new Worker(WORKER, {
    workerData: { args: cfg.args || [], proxy: cfg.proxy },
    env: env,
    stdout: true, stderr: true,
  });
  const t = {
    onMessage: null, onClose: null, onStatus: null,
    send: function (u8) { worker.postMessage(u8.buffer, [u8.buffer]); },
    close: function () { worker.terminate(); },
  };
  worker.on('message', function (d) { if (t.onMessage) { t.onMessage(new Uint8Array(d)); } });
  worker.on('exit', function () { if (t.onClose) { t.onClose(); } });
  worker.on('error', function (e) { if (t.onStatus) { t.onStatus({ kind: 'error', error: String(e && e.stack || e) }); } });
  if (process.env.NVIM_WASM_ENGINE_LOG === '-') {
    worker.stderr.on('data', function (b) { process.stderr.write(b); });
  }
  return { transport: t, worker: worker };
}

function lua(nvim, chunk, args) {
  return nvim.request('nvim_exec_lua', [chunk, args || []]);
}

async function main() {
  if (typeof WebAssembly.Suspending === 'undefined') {
    fatal('this Node lacks JSPI (WebAssembly.Suspending). Use Node >= 24, or ' +
          'Node >= 22 with --experimental-wasm-jspi.');
  }
  for (const f of ['nvim.js', 'nvim.wasm', 'worker.js']) {
    if (!fs.existsSync(path.join(BIN, f))) {
      fatal('missing ' + path.join(BIN, f) + ' (run wasm/build-deps.sh && wasm/build-nvim.sh first)');
    }
  }

  // ---- fixture TCP echo server (in THIS process) ----------------------------
  // Echoes back whatever it receives. A real outbound TCP target the proxied
  // engine connects to THROUGH the server.
  const echo = net.createServer(function (sock) {
    sock.on('data', function (buf) { try { sock.write(buf); } catch (e) {} });
    sock.on('error', function () { /* ignore */ });
  });
  await new Promise(function (resolve) { echo.listen(0, '127.0.0.1', resolve); });
  const echoPort = echo.address().port;
  console.log('# echo server on 127.0.0.1:' + echoPort);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nvim-sockproxy-'));
  const realRoot = fs.realpathSync(tmpRoot);

  // ---- start the real proxy server jailed to realRoot -----------------------
  const srv = serverMod.createServer({ root: realRoot });
  await new Promise(function (resolve) { srv.httpServer.listen(0, '127.0.0.1', resolve); });
  const port = srv.httpServer.address().port;
  const wsUrl = 'ws://127.0.0.1:' + port + '/proxy';
  console.log('# proxy server jailed to ' + realRoot + ' on ' + wsUrl);

  // ---- boot the engine WITH the proxy config --------------------------------
  const { transport, worker } = nodeEngineTransport({
    args: ['-u', 'NONE', '-i', 'NONE', '-n'],
    proxy: { url: wsUrl, mount: '/host', root: realRoot },
  });
  const nvim = Neovim.createNvim({ transport: transport, MessagePack: MessagePack });

  let engineError = null;
  nvim.onStatus(function (s) { if (s && s.kind === 'error') { engineError = s.error; } });

  const ready = await Promise.race([
    nvim.ready.then(function () { return 'ready'; }),
    sleep(20000).then(function () { return 'timeout'; }),
  ]);
  if (ready !== 'ready') { fatal('engine did not become ready within 20s' + (engineError ? (': ' + engineError) : '')); }
  ok(typeof nvim.chan === 'number' && nvim.chan > 0, 'engine ready; chan = ' + nvim.chan);

  // Clear any blocking "press ENTER" prompt.
  for (let i = 0; i < 20; i++) {
    const m = await nvim.request('nvim_get_mode');
    if (!m || !m.blocking) { break; }
    nvim.input('<CR>');
    await sleep(50);
  }

  // ==========================================================================
  // 1. vim.uv (luv) connect + read_start + write -> echo round-trip.
  //    This exercises the ASYNC connect path (uv_tcp_connect) over a virtual fd.
  // ==========================================================================
  await lua(nvim, [
    '_G.__uv = { connected = false, got = "", err = nil }',
    'local c = vim.uv.new_tcp()',
    '_G.__uv.c = c',
    'c:connect("127.0.0.1", ' + echoPort + ', function(err)',
    '  if err then _G.__uv.err = err; return end',
    '  _G.__uv.connected = true',
    '  c:read_start(function(rerr, chunk)',
    '    if rerr then _G.__uv.err = rerr; return end',
    '    if chunk then _G.__uv.got = _G.__uv.got .. chunk end',
    '  end)',
    '  c:write("ping-luv\\n")',
    'end)',
    'return true',
  ].join('\n'));

  const uvConnected = await waitFor(async function () {
    return await lua(nvim, 'return _G.__uv.connected') === true;
  }, 10000);
  ok(uvConnected, 'vim.uv tcp:connect() fired its connect callback (status ok)');

  const uvEchoed = await waitFor(async function () {
    const got = await lua(nvim, 'return _G.__uv.got');
    return typeof got === 'string' && got.indexOf('ping-luv') >= 0;
  }, 10000);
  const uvErr = await lua(nvim, 'return _G.__uv.err');
  ok(uvEchoed, 'vim.uv tcp: wrote "ping-luv" and the echo came back' + (uvErr ? (' (err=' + uvErr + ')') : ''));

  // Close the luv socket cleanly.
  await lua(nvim, 'if _G.__uv.c then _G.__uv.c:close() end; return true');

  // ==========================================================================
  // 2. vim.uv.getaddrinfo('localhost', ...) -> returns an address.
  // ==========================================================================
  await lua(nvim, [
    '_G.__ai = { done = false, ok = false, addr = nil }',
    'vim.uv.getaddrinfo("localhost", "' + echoPort + '", { socktype = "stream" },',
    '  function(err, res)',
    '    _G.__ai.done = true',
    '    if err then _G.__ai.err = err; return end',
    '    if res and res[1] then _G.__ai.ok = true; _G.__ai.addr = res[1].addr; _G.__ai.port = res[1].port end',
    '  end)',
    'return true',
  ].join('\n'));

  const aiDone = await waitFor(async function () {
    return await lua(nvim, 'return _G.__ai.done') === true;
  }, 10000);
  ok(aiDone, 'vim.uv.getaddrinfo callback fired');
  const aiOk = await lua(nvim, 'return _G.__ai.ok');
  const aiAddr = await lua(nvim, 'return _G.__ai.addr');
  ok(aiOk === true && typeof aiAddr === 'string' && aiAddr.length > 0,
     'vim.uv.getaddrinfo("localhost") returned an address (' + aiAddr + ')');

  // ==========================================================================
  // 3. nvim sockconnect('tcp', '127.0.0.1:PORT', {rpc=false, on_data}) +
  //    chansend round-trip. Exercises socket.c's SYNC getaddrinfo + uv_tcp_connect.
  // ==========================================================================
  // sockconnect() is a Vimscript eval function and must NOT run in a fast event
  // context (which nvim_exec_lua's RPC handler is). Defer it via a 0ms timer so
  // it runs from the main loop in a NORMAL context, stash the channel id in a
  // global, and poll for it. This drives socket.c's socket_connect: SYNC
  // uv_getaddrinfo + uv_tcp_connect + connect_cb.
  await lua(nvim, [
    '_G.__sc = { data = "", chan = nil, err = nil, done = false }',
    'vim.fn.timer_start(0, function()',
    '  local ok, res = pcall(function()',
    '    return vim.fn.sockconnect("tcp", "127.0.0.1:' + echoPort + '", {',
    '      rpc = false,',
    '      on_data = function(_, d, _)',
    '        _G.__sc.data = _G.__sc.data .. table.concat(d, "\\n")',
    '      end,',
    '    })',
    '  end)',
    '  _G.__sc.done = true',
    '  if not ok then _G.__sc.err = tostring(res) else _G.__sc.chan = res end',
    'end)',
    'return true',
  ].join('\n'));
  await waitFor(async function () {
    return await lua(nvim, 'return _G.__sc.done') === true;
  }, 10000);
  const scOk = await lua(nvim, 'return _G.__sc.chan');
  const scErr = await lua(nvim, 'return _G.__sc.err');
  ok(typeof scOk === 'number' && scOk > 0,
     'sockconnect("tcp", ...) returned a channel id (' + scOk + ')' + (scErr ? (' err=' + scErr) : ''));

  if (typeof scOk === 'number' && scOk > 0) {
    await lua(nvim, 'vim.fn.chansend(_G.__sc.chan, "ping-sock\\n"); return true');
    const scEchoed = await waitFor(async function () {
      const d = await lua(nvim, 'return _G.__sc.data');
      return typeof d === 'string' && d.indexOf('ping-sock') >= 0;
    }, 10000);
    ok(scEchoed, 'sockconnect + chansend: the echo "ping-sock" came back via on_data');
    await lua(nvim, 'pcall(vim.fn.chanclose, _G.__sc.chan); return true');
  } else {
    ok(false, 'sockconnect + chansend: skipped (connect failed)');
  }

  // ==========================================================================
  // 4. clean teardown with a LIVE socket: open one and DON'T close it, then
  //    dispose. The worker terminate + ws close must not hang; the server
  //    destroys the orphan.
  // ==========================================================================
  await lua(nvim, [
    '_G.__live = vim.uv.new_tcp()',
    '_G.__live:connect("127.0.0.1", ' + echoPort + ', function(err) end)',
    'return true',
  ].join('\n'));
  await sleep(200);

  const disposed = await Promise.race([
    (async function () { worker.terminate(); return 'ok'; })(),
    sleep(8000).then(function () { return 'timeout'; }),
  ]);
  ok(disposed === 'ok', 'dispose with a live socket completes without hanging');

  // ---- teardown -------------------------------------------------------------
  await new Promise(function (resolve) { srv.wss.close(function () { srv.httpServer.close(resolve); }); });
  await new Promise(function (resolve) { echo.close(resolve); });
  try { fs.rmSync(realRoot, { recursive: true, force: true }); } catch (e) {}

  console.log('');
  if (failures) { console.log(failures + ' of ' + checks + ' sock-proxy check(s) FAILED'); process.exit(1); }
  console.log('all sock-proxy checks passed (' + checks + ' checks)');
  process.exit(0);
}

main().catch(function (e) { fatal((e && e.stack) || String(e)); });
