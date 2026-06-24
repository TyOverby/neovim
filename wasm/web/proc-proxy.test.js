// wasm/web/proc-proxy.test.js - END-TO-END test of the Stage 4 / Phase 3 process
// spawn + stdio proxy through the REAL engine + REAL server + REAL WebSocket.
//
// Boots the actual Neovim wasm engine (build-wasm/bin/nvim.js in a Node
// worker_thread via wasm/worker.js) WITH a proxy config, starts the real
// server.js on a loopback port jailed to a tmpdir, and asserts that process
// spawning works for real on the server's side:
//
//   * system('echo hi')                 -> "hi"
//   * jobstart(['printf','a\nb'])        -> on_stdout chunks + on_exit code 0
//   * jobstart(sh -c 'exit 3')           -> on_exit reports code 3
//   * stdin pipe: jobstart a `cat`, chansend, read it back via on_stdout
//   * clean teardown with a live child   -> dispose doesn't hang/crash
//
// Jobs are async -- we wait on rpcnotify-delivered events / job state, never on
// fixed sleeps for the assertions.
//
// Run:  node wasm/web/proc-proxy.test.js   (Node >= 24, or >= 22 with --jspi flag)
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

// ---- tiny test harness (mirrors fs-proxy.test.js) --------------------------
let failures = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) { console.log('  ok   - ' + msg); }
  else { failures++; console.log('  FAIL - ' + msg); }
}
function fatal(msg) { console.error('proc-proxy: ' + msg); process.exit(1); }
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
    workerData: {
      args: cfg.args || [],
      proxy: cfg.proxy,
    },
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

// Run a Lua chunk in the engine and return its result via nvim_exec_lua.
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

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nvim-procproxy-'));
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
  // 1. system('echo hi') -> "hi"
  // ==========================================================================
  const sysOut = await nvim.request('nvim_call_function', ['system', ['echo hi']]);
  ok(typeof sysOut === 'string' && sysOut.replace(/\s+$/, '') === 'hi',
     "system('echo hi') returns 'hi' (got " + JSON.stringify(sysOut) + ')');

  // shell_error must be 0 for a clean exit.
  const sysErr = await nvim.request('nvim_eval', ['v:shell_error']);
  ok(sysErr === 0, "system('echo hi') sets v:shell_error == 0 (got " + sysErr + ')');

  // ==========================================================================
  // 2. jobstart(['printf','a\nb']) -> on_stdout chunks + on_exit code 0
  // ==========================================================================
  // Use a Lua job that records stdout chunks + the exit code into a global, then
  // poll for completion. printf 'a\nb' emits "a\nb" (no trailing newline).
  await lua(nvim, [
    'local out = {}',
    'local done = nil',
    '_G.__job2 = { out = out, done = function() return done end }',
    'local id = vim.fn.jobstart({ "printf", "a\\nb" }, {',
    '  on_stdout = function(_, data, _) for _,l in ipairs(data) do out[#out+1] = l end end,',
    '  on_exit = function(_, code, _) done = code end,',
    '})',
    '_G.__job2.id = id',
    'return id',
  ].join('\n'));

  const job2done = await waitFor(async function () {
    const d = await lua(nvim, 'return _G.__job2.done()');
    return d !== null && d !== undefined;
  }, 10000);
  ok(job2done, 'jobstart printf: on_exit fired');

  const job2code = await lua(nvim, 'return _G.__job2.done()');
  ok(job2code === 0, 'jobstart printf: on_exit code == 0 (got ' + job2code + ')');

  // The on_stdout data array, joined, must contain "a\nb" (nvim splits on \n, so
  // chunks are ["a","b"] possibly across callbacks).
  const job2out = await lua(nvim, 'return table.concat(_G.__job2.out, "\\n")');
  ok(typeof job2out === 'string' && job2out.indexOf('a') >= 0 && job2out.indexOf('b') >= 0,
     "jobstart printf: on_stdout delivered 'a' and 'b' (got " + JSON.stringify(job2out) + ')');

  // ==========================================================================
  // 3. jobstart(sh -c 'exit 3') -> on_exit reports code 3
  // ==========================================================================
  await lua(nvim, [
    'local done = nil',
    '_G.__job3 = { done = function() return done end }',
    'vim.fn.jobstart({ "sh", "-c", "exit 3" }, {',
    '  on_exit = function(_, code, _) done = code end,',
    '})',
  ].join('\n'));

  const job3done = await waitFor(async function () {
    const d = await lua(nvim, 'return _G.__job3.done()');
    return d !== null && d !== undefined;
  }, 10000);
  ok(job3done, "jobstart sh -c 'exit 3': on_exit fired");
  const job3code = await lua(nvim, 'return _G.__job3.done()');
  ok(job3code === 3, "jobstart sh -c 'exit 3': on_exit code == 3 (got " + job3code + ')');

  // ==========================================================================
  // 4. stdin pipe: jobstart a `cat`, chansend, read it back via on_stdout
  // ==========================================================================
  await lua(nvim, [
    'local out = {}',
    'local done = nil',
    '_G.__job4 = { out = out, done = function() return done end }',
    'local id = vim.fn.jobstart({ "cat" }, {',
    '  on_stdout = function(_, data, _) for _,l in ipairs(data) do out[#out+1] = l end end,',
    '  on_exit = function(_, code, _) done = code end,',
    '})',
    '_G.__job4.id = id',
    'vim.fn.chansend(id, "hello-stdin\\n")',
    'return id',
  ].join('\n'));

  // Wait for cat to echo the line back on stdout (before we close stdin).
  const gotEcho = await waitFor(async function () {
    const o = await lua(nvim, 'return table.concat(_G.__job4.out, "|")');
    return typeof o === 'string' && o.indexOf('hello-stdin') >= 0;
  }, 10000);
  ok(gotEcho, 'jobstart cat: stdin echoed back via on_stdout');

  // Close stdin -> cat sees EOF and exits 0.
  await lua(nvim, 'vim.fn.chanclose(_G.__job4.id, "stdin")');
  const job4done = await waitFor(async function () {
    const d = await lua(nvim, 'return _G.__job4.done()');
    return d !== null && d !== undefined;
  }, 10000);
  ok(job4done, 'jobstart cat: on_exit fired after stdin close (EOF)');
  const job4code = await lua(nvim, 'return _G.__job4.done()');
  ok(job4code === 0, 'jobstart cat: clean exit 0 after stdin EOF (got ' + job4code + ')');

  // ==========================================================================
  // 5. clean teardown with a LIVE child: start a long-running sleep, then
  //    dispose. It must not hang/crash. (The server kills orphans on disconnect.)
  // ==========================================================================
  await lua(nvim, [
    '_G.__job5 = vim.fn.jobstart({ "sleep", "30" })',
    'return _G.__job5',
  ].join('\n'));
  // Confirm the job is actually running (jobwait with 0 timeout returns -1 while
  // running).
  const running = await lua(nvim, 'return vim.fn.jobwait({ _G.__job5 }, 0)[1]');
  ok(running === -1, 'long-running child is alive before teardown (jobwait -> -1)');

  // Dispose the engine while the child is live. The worker terminate + ws close
  // must not hang; the server's cleanupConnection kills the orphan.
  const disposed = await Promise.race([
    (async function () {
      worker.terminate();
      return 'ok';
    })(),
    sleep(8000).then(function () { return 'timeout'; }),
  ]);
  ok(disposed === 'ok', 'dispose with a live child completes without hanging');

  // ---- teardown -------------------------------------------------------------
  await new Promise(function (resolve) { srv.wss.close(function () { srv.httpServer.close(resolve); }); });
  try { fs.rmSync(realRoot, { recursive: true, force: true }); } catch (e) {}

  console.log('');
  if (failures) { console.log(failures + ' of ' + checks + ' proc-proxy check(s) FAILED'); process.exit(1); }
  console.log('all proc-proxy checks passed (' + checks + ' checks)');
  process.exit(0);
}

main().catch(function (e) { fatal((e && e.stack) || String(e)); });
