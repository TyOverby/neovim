// wasm/web/e2e.test.js - headless end-to-end test of the browser library split.
//
// Boots the REAL Neovim engine (build-wasm/bin/nvim.js, hosted in a Node
// worker_thread via wasm/worker.js) and drives it through the very same library
// layers the browser page uses:
//   * neovim.js      - the headless msgpack-RPC core (here over a Node worker
//                      transport instead of a Web Worker; the core can't tell).
//   * neovim-ui.js   - the headless Screen (redraw -> grid decode) the page
//                      renders into. We assert on it directly, no DOM.
//
// This is what validates that the core/renderer split is clean: if either layer
// secretly depended on the DOM or on a specific worker host, this test couldn't
// run. It also locks the msgpack-RPC contract end to end.
//
// Prereqs: a finished wasm/build-nvim.sh (build-wasm/bin/{nvim.js,nvim.wasm,
// nvim.data,worker.js}) and `npm install` in wasm/web (@msgpack/msgpack).
// Run:  node wasm/web/e2e.test.js        (Node >= 24, or >= 22 with
//                                          --experimental-wasm-jspi)
'use strict';

const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');

const MessagePack = require('@msgpack/msgpack');
const Neovim = require('./neovim.js');
const NeovimUI = require('./neovim-ui.js');

const ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(ROOT, 'build-wasm', 'bin');
const WORKER = path.join(BIN, 'worker.js');

// ---- tiny test harness ----------------------------------------------------
let failures = 0;
function ok(cond, msg) {
  if (cond) { console.log('  ok   - ' + msg); }
  else { failures++; console.log('  FAIL - ' + msg); }
}
function fatal(msg) { console.error('e2e: ' + msg); process.exit(1); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function waitFor(pred, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) { return true; }
    await sleep(25);
  }
  return false;
}

// ---- a Node worker_thread transport (the analogue of the browser worker) ---
// `cfg` carries the create() runtime config { args, env, cwd, filesystem }; it is
// forwarded on workerData exactly as the browser path posts it in the worker's
// init message, so worker.js -> pre.js apply identical logic in both targets.
function nodeEngineTransport(cfg) {
  cfg = cfg || {};
  // Give the engine a clean env: drop NVIM_LOG_FILE so worker.js's `.engine`
  // suffix can't point at an unwritable path (which would emit a startup
  // warning -> hit-enter prompt). CI won't have it set; a dev shell might.
  const env = Object.assign({}, process.env);
  delete env.NVIM_LOG_FILE;
  const worker = new Worker(WORKER, {
    // worker.js prepends `--embed` to args and forwards env/cwd/filesystem to
    // the __nvim* globals pre.js reads.
    workerData: {
      args: cfg.args || [],
      env: cfg.env,
      cwd: cfg.cwd,
      filesystem: cfg.filesystem,
    },
    env: env,
    stdout: true, stderr: true,           // capture; don't litter the test output
  });
  const t = {
    onMessage: null, onClose: null, onStatus: null,
    send: function (u8) { worker.postMessage(u8.buffer, [u8.buffer]); },
    close: function () { worker.terminate(); },
  };
  worker.on('message', function (d) { if (t.onMessage) { t.onMessage(new Uint8Array(d)); } });
  worker.on('exit', function () { if (t.onClose) { t.onClose(); } });
  worker.on('error', function (e) { if (t.onStatus) { t.onStatus({ kind: 'error', error: String(e && e.stack || e) }); } });
  // Surface engine stderr only when explicitly debugging.
  if (process.env.NVIM_WASM_ENGINE_LOG === '-') {
    worker.stderr.on('data', function (b) { process.stderr.write(b); });
  }
  return { transport: t, worker: worker };
}

async function main() {
  if (typeof WebAssembly.Suspending === 'undefined') {
    fatal('this Node lacks JSPI (WebAssembly.Suspending). Use Node >= 24, or ' +
          'Node >= 22 with --experimental-wasm-jspi.');
  }
  for (const f of ['nvim.js', 'nvim.wasm', 'nvim.data', 'worker.js']) {
    if (!fs.existsSync(path.join(BIN, f))) {
      fatal('missing ' + path.join(BIN, f) + ' (run wasm/build-deps.sh && wasm/build-nvim.sh first)');
    }
  }

  // `-n` disables swap files (otherwise E303 + the intro both queue messages and
  // nvim raises a "Press ENTER" prompt that blocks input/RPC). `-u/-i NONE` keep
  // the session pristine, matching the browser demo.
  //
  // Exercise the create() runtime config seam (env/cwd/filesystem) on the SAME
  // path the browser uses: the values ride workerData -> worker.js -> __nvim*
  // globals -> pre.js preRun, identical to the browser's init message ->
  // engine-worker.js -> __nvim* globals -> pre.js. We assert each took effect via
  // RPC below (checks 6-8).
  const { transport, worker } = nodeEngineTransport({
    args: ['-u', 'NONE', '-i', 'NONE', '-n'],
    env: { NVIM_WASM_PROBE: 'hi-from-env' },
    filesystem: { '/work/hello.txt': 'seeded-contents\n' },
    cwd: '/work',
  });
  const nvim = Neovim.createNvim({ transport: transport, MessagePack: MessagePack });

  let engineError = null;
  nvim.onStatus(function (s) { if (s && s.kind === 'error') { engineError = s.error; } });

  // 1. Core boots and round-trips RPC: nvim.ready resolves with our channel id.
  const ready = await Promise.race([
    nvim.ready.then(function () { return 'ready'; }),
    sleep(20000).then(function () { return 'timeout'; }),
  ]);
  if (ready !== 'ready') { fatal('engine did not become ready within 20s' + (engineError ? (': ' + engineError) : '')); }
  ok(typeof nvim.chan === 'number' && nvim.chan > 0, 'nvim_get_api_info round-trips; chan = ' + nvim.chan);

  // 2. Renderer: drive the SAME headless Screen the page renders into.
  const screen = new NeovimUI.Screen(80, 24);
  nvim.onNotification('redraw', function (params) { screen.handleRedraw(params); });
  await nvim.request('nvim_ui_attach', [80, 24, { rgb: true, ext_linegrid: true }]);

  // Clear any residual startup "Press ENTER" prompt before driving input, so a
  // stray message in some environment can't make the test flaky.
  for (let i = 0; i < 20; i++) {
    const m = await nvim.request('nvim_get_mode');
    if (!m || !m.blocking) { break; }
    nvim.input('<CR>');
    await sleep(50);
  }

  // 3. Type into the buffer and assert the grid reflects it.
  nvim.input('ihello');
  nvim.input('<Esc>');
  const typed = await waitFor(function () { return /(^|\n)hello/.test(screen.text()); }, 10000);
  ok(typed, "typing 'ihello<Esc>' renders 'hello' on the grid");
  ok(screen.text().split('\n')[0].indexOf('hello') === 0, "'hello' is at the start of row 0");
  // After `ihello<Esc>` the cursor rests on the last inserted char ('o', col 4).
  // Wait for the post-Esc cursor_goto to land before asserting.
  const curOk = await waitFor(function () { return screen.cursor.row === 0 && screen.cursor.col === 4; }, 5000);
  ok(curOk, 'cursor decoded to row 0 col 4 (got ' + screen.cursor.row + ',' + screen.cursor.col + ')');

  // 4. Command line is drawn into the bottom grid row (no ext_cmdline).
  nvim.input(':');
  const cmdline = await waitFor(function () { return screen.text().split('\n')[screen.rows - 1].indexOf(':') === 0; }, 5000);
  ok(cmdline, "':' opens a command line on the bottom row");
  nvim.input('<Esc>');

  // ---- create() runtime config (env / filesystem / cwd) ---------------------
  // These assert the config we passed into nodeEngineTransport above reached the
  // engine via the create() seam (workerData -> worker.js -> __nvim* -> pre.js).

  // 6. env: pre.js applied our override on top of its defaults, so $NVIM_WASM_PROBE
  //    is visible to nvim's expand().
  const probe = await nvim.request('nvim_eval', ['$NVIM_WASM_PROBE']);
  ok(probe === 'hi-from-env', "env override is visible to nvim ($NVIM_WASM_PROBE = '" + probe + "')");

  // 7. filesystem: the seeded file exists in the wasm FS with the given contents.
  const lines = await nvim.request('nvim_exec_lua', ['return vim.fn.readfile("/work/hello.txt")', []]);
  ok(Array.isArray(lines) && lines.length === 1 && lines[0] === 'seeded-contents',
     "seeded /work/hello.txt reads back as 'seeded-contents' (got " + JSON.stringify(lines) + ')');

  // 8. cwd: pre.js chdir'd into the seeded dir, so getcwd() reflects it.
  const cwd = await nvim.request('nvim_eval', ['getcwd()']);
  ok(cwd === '/work', "cwd took effect (getcwd() = '" + cwd + "')");

  // 9. Lifecycle: when the engine goes away, the core must observe EOF and tear
  // down. This is the path the browser relies on (engine-worker posts
  // {kind:'exit'} -> transport.onClose -> the core closes). We simulate the
  // engine vanishing by terminating its worker, then assert the core both emits
  // 'exit' and rejects any in-flight request (so callers never hang).
  // (Note: in the BROWSER, `:qa!` terminates the engine and engine-worker.js
  // posts {kind:'exit'} on Module.onExit, so the channel closes on its own. The
  // Node host (wasm/worker.js) doesn't hook Module.onExit -- its worker_thread
  // stays alive in the JSPI-suspended poll -- so `:qa!` over RPC doesn't close
  // the channel here yet; we close from the host side instead. Either way this
  // exercises the same transport.onClose -> core-close path.)
  let closed = false;
  nvim.onStatus(function (s) { if (s && s.kind === 'exit') { closed = true; } });
  const hangs = nvim.request('nvim_eval', ['1+1']);   // in-flight across the close
  let rejected = false;
  hangs.catch(function () { rejected = true; });
  worker.terminate();
  await waitFor(function () { return closed; }, 5000);
  ok(closed, 'engine going away closes the channel (EOF propagates to the core)');
  await waitFor(function () { return rejected; }, 2000);
  ok(rejected, 'in-flight requests reject when the channel closes');

  console.log('');
  if (failures) { console.log(failures + ' check(s) FAILED'); process.exit(1); }
  console.log('all checks passed');
  process.exit(0);
}

main().catch(function (e) { fatal((e && e.stack) || String(e)); });
