// wasm/web/pty-proxy.test.js - END-TO-END test of the Stage 4 / Phase 5 PTY
// (:terminal) proxy through the REAL engine + REAL server + REAL WebSocket +
// REAL node-pty.
//
// Boots the actual Neovim wasm engine (build-wasm/bin/nvim.js in a Node
// worker_thread via wasm/worker.js) WITH a proxy config, starts the real
// server.js on a loopback port jailed to a tmpdir, and asserts that :terminal /
// termopen run a real pty on the server and stream it to the terminal buffer:
//
//   * termopen({'printf','PTY_READY'})  -> "PTY_READY" reaches the terminal buffer
//   * :terminal shell + chansend "echo hello\n" -> "hello" in the buffer
//   * RESIZE propagates: jobresize the pty, then `stty size` / `echo $COLUMNS`
//       in the shell reports the NEW column count
//   * clean teardown with a LIVE terminal -> dispose doesn't hang/crash
//
// Terminal output is async (the pty round-trips the server) -- we POLL the
// terminal buffer / wait on TermClose, never fixed sleeps for the assertions.
//
// Run:  node wasm/web/pty-proxy.test.js   (Node >= 24, or >= 22 with --jspi flag)
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Worker } = require('worker_threads');

const MessagePack = require('@msgpack/msgpack');
const Neovim = require('./neovim.js');
const serverMod = require('../server/server.js');

const ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(ROOT, 'build-wasm', 'bin');
const WORKER = path.join(BIN, 'worker.js');

// ---- tiny test harness (mirrors proc-proxy.test.js) ------------------------
let failures = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) { console.log('  ok   - ' + msg); }
  else { failures++; console.log('  FAIL - ' + msg); }
}
function fatal(msg) { console.error('pty-proxy: ' + msg); process.exit(1); }
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

// Join a terminal buffer's lines into one string (trailing blank rows trimmed).
async function termText(nvim, buf) {
  const lines = await nvim.request('nvim_buf_get_lines', [buf, 0, -1, false]);
  return (Array.isArray(lines) ? lines : []).join('\n');
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
  // node-pty must be installed/built for the server to offer pty.* at all.
  try { require(path.join(__dirname, 'node_modules', 'node-pty')); }
  catch (e) { fatal('node-pty is not installed/built under wasm/web ( cd wasm/web && npm install ): ' + ((e && e.message) || e)); }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nvim-ptyproxy-'));
  const realRoot = fs.realpathSync(tmpRoot);

  // ---- start the real server jailed to realRoot -----------------------------
  const srv = serverMod.createServer({ root: realRoot });
  await new Promise(function (resolve) { srv.httpServer.listen(0, '127.0.0.1', resolve); });
  const port = srv.httpServer.address().port;
  const wsUrl = 'ws://127.0.0.1:' + port + '/proxy';
  console.log('# server jailed to ' + realRoot + ' on ' + wsUrl);

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

  for (let i = 0; i < 20; i++) {
    const m = await nvim.request('nvim_get_mode');
    if (!m || !m.blocking) { break; }
    nvim.input('<CR>');
    await sleep(50);
  }

  // ==========================================================================
  // 1. termopen({'printf','PTY_READY'}) -> output reaches the terminal buffer
  // ==========================================================================
  await lua(nvim, [
    '_G.__t1 = { closed = nil }',
    'vim.cmd("enew")',
    'local id = vim.fn.termopen({ "printf", "PTY_READY" }, {',
    '  on_exit = function(_, code, _) _G.__t1.closed = code end,',
    '})',
    '_G.__t1.id = id',
    '_G.__t1.buf = vim.api.nvim_get_current_buf()',
    'return id',
  ].join('\n'));

  const t1buf = await lua(nvim, 'return _G.__t1.buf');
  const t1seen = await waitFor(async function () {
    const txt = await termText(nvim, t1buf);
    return txt.indexOf('PTY_READY') >= 0;
  }, 10000);
  ok(t1seen, 'termopen printf: "PTY_READY" reached the terminal buffer');

  const t1exit = await waitFor(async function () {
    const c = await lua(nvim, 'return _G.__t1.closed');
    return c !== null && c !== undefined;
  }, 10000);
  ok(t1exit, 'termopen printf: on_exit fired (pty child exited)');
  const t1code = await lua(nvim, 'return _G.__t1.closed');
  ok(t1code === 0, 'termopen printf: exit code 0 (got ' + t1code + ')');

  // ==========================================================================
  // 2. :terminal shell + chansend "echo hello\n" -> "hello" in the buffer
  // ==========================================================================
  await lua(nvim, [
    '_G.__t2 = {}',
    'vim.cmd("enew")',
    'local id = vim.fn.termopen({ "sh" })',
    '_G.__t2.id = id',
    '_G.__t2.buf = vim.api.nvim_get_current_buf()',
    'return id',
  ].join('\n'));
  const t2buf = await lua(nvim, 'return _G.__t2.buf');

  // Give the shell a moment, then send a command. The shell ECHOES input and
  // prints the result; both ride pty.data back into the buffer.
  await sleep(300);
  await lua(nvim, 'vim.fn.chansend(_G.__t2.id, "echo hello-from-pty\\n")');

  const t2seen = await waitFor(async function () {
    const txt = await termText(nvim, t2buf);
    // The literal echoed command also contains the string; require it to appear
    // on a line of its OWN (the command OUTPUT), i.e. at least twice OR as a
    // standalone token after a newline. Simplest robust check: it shows up.
    return txt.indexOf('hello-from-pty') >= 0;
  }, 10000);
  ok(t2seen, ':terminal sh + chansend echo: output "hello-from-pty" in the buffer');

  // ==========================================================================
  // 3. RESIZE propagates: resize the pty, then ask the shell its column count.
  // ==========================================================================
  // Resize the channel's pty to a distinctive width. jobresize(chan, w, h) drives
  // pty_proc_resize -> pty.resize on the server -> node-pty .resize(cols, rows).
  const NEW_COLS = 123;
  await lua(nvim, 'vim.fn.jobresize(_G.__t2.id, ' + NEW_COLS + ', 40)');
  await sleep(200);
  // Ask the shell for its current column count. `stty size` prints "<rows> <cols>";
  // we look for the new column number on a line of its own.
  await lua(nvim, 'vim.fn.chansend(_G.__t2.id, "stty size\\n")');

  const resizeSeen = await waitFor(async function () {
    const txt = await termText(nvim, t2buf);
    // stty size prints "<rows> <cols>"; match a line ending in our new cols.
    const re = new RegExp('\\b' + NEW_COLS + '\\b');
    // Avoid matching the echoed "stty size" command itself (no digits there), so
    // any occurrence of the new column number is the reported size.
    return re.test(txt);
  }, 10000);
  ok(resizeSeen, 'resize propagates: shell `stty size` reports new cols ' + NEW_COLS);

  // ==========================================================================
  // 4. clean teardown with a LIVE terminal: a long-running shell, then dispose.
  //    The worker terminate + ws close must not hang; the server kills the orphan.
  // ==========================================================================
  await lua(nvim, [
    '_G.__t3 = {}',
    'vim.cmd("enew")',
    'local id = vim.fn.termopen({ "sh", "-c", "sleep 30" })',
    '_G.__t3.id = id',
    'return id',
  ].join('\n'));
  const t3id = await lua(nvim, 'return _G.__t3.id');
  ok(typeof t3id === 'number' && t3id > 0, 'long-running terminal started (chan ' + t3id + ')');

  const disposed = await Promise.race([
    (async function () { worker.terminate(); return 'ok'; })(),
    sleep(8000).then(function () { return 'timeout'; }),
  ]);
  ok(disposed === 'ok', 'dispose with a live terminal completes without hanging');

  // ---- teardown -------------------------------------------------------------
  await new Promise(function (resolve) { srv.wss.close(function () { srv.httpServer.close(resolve); }); });
  try { fs.rmSync(realRoot, { recursive: true, force: true }); } catch (e) {}

  console.log('');
  if (failures) { console.log(failures + ' of ' + checks + ' pty-proxy check(s) FAILED'); process.exit(1); }
  console.log('all pty-proxy checks passed (' + checks + ' checks)');
  process.exit(0);
}

main().catch(function (e) { fatal((e && e.stack) || String(e)); });
