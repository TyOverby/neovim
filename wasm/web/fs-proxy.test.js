// wasm/web/fs-proxy.test.js - END-TO-END test of the Stage 4 / Phase 2 filesystem
// proxy through the REAL engine + REAL server + REAL WebSocket.
//
// This boots the actual Neovim wasm engine (build-wasm/bin/nvim.js in a Node
// worker_thread via wasm/worker.js) WITH a proxy config, starts the real
// server.js on a loopback port jailed to a tmpdir, and asserts that file IO under
// the mount prefix (/host) round-trips to the server's real disk:
//
//   * :e /host/<file>          -> buffer lines == the on-disk file (fs.open/read)
//   * edit + :w                -> the on-disk file changed (fs.write)
//   * :w /host/new.txt         -> a NEW file appears on disk inside root
//   * glob('/host/*')          -> lists the real directory entries (getdents)
//   * /host/../escape & abs     -> jail denies the escape (no file leaks)
//
// It also proves the HARD INVARIANT separately (e2e.test.js still green) by NOT
// touching the no-proxy path.
//
// Run:  node wasm/web/fs-proxy.test.js   (Node >= 24, or >= 22 with --jspi flag)
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

// ---- tiny test harness (mirrors e2e.test.js) -------------------------------
let failures = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) { console.log('  ok   - ' + msg); }
  else { failures++; console.log('  FAIL - ' + msg); }
}
function fatal(msg) { console.error('fs-proxy: ' + msg); process.exit(1); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function waitFor(pred, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) { return true; }
    await sleep(25);
  }
  return false;
}

// A Node worker_thread transport that ALSO threads a `proxy` config onto
// workerData (worker.js opens the IO-proxy WebSocket from it). Mirrors
// e2e.test.js's nodeEngineTransport plus the proxy field.
function nodeEngineTransport(cfg) {
  cfg = cfg || {};
  const env = Object.assign({}, process.env);
  delete env.NVIM_LOG_FILE;
  const worker = new Worker(WORKER, {
    workerData: {
      args: cfg.args || [],
      env: cfg.env,
      cwd: cfg.cwd,
      filesystem: cfg.filesystem,
      proxy: cfg.proxy,            // { url, mount, root } -> worker.js setupProxy
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

  // ---- set up the jailed server root with a known fixture -------------------
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nvim-fsproxy-'));
  // Resolve symlinks (macOS/Linux /tmp can be a symlink) so on-disk asserts and
  // the server's realpath jail agree.
  const realRoot = fs.realpathSync(tmpRoot);
  const FIXTURE = 'line one\nline two\nline three\n';
  fs.writeFileSync(path.join(realRoot, 'fixture.txt'), FIXTURE);
  fs.mkdirSync(path.join(realRoot, 'subdir'));
  fs.writeFileSync(path.join(realRoot, 'subdir', 'inner.txt'), 'inner contents\n');
  // A file OUTSIDE the root, to prove the jail denies escapes.
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvim-outside-'));
  const realOutside = fs.realpathSync(outsideDir);
  fs.writeFileSync(path.join(realOutside, 'secret.txt'), 'TOP SECRET should never leak\n');

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

  // Clear any residual startup prompt before driving commands.
  for (let i = 0; i < 20; i++) {
    const m = await nvim.request('nvim_get_mode');
    if (!m || !m.blocking) { break; }
    nvim.input('<CR>');
    await sleep(50);
  }

  // Disable swap/backup/undo globally before any edit. `-n` leaves the option on;
  // a swap/backup file under /host adds noise unrelated to the data-path assertions
  // here. (The proxy CAN serve swap/backup files -- they are just more /host
  // files -- but the round-trip per probe makes the test slower and flakier.)
  await nvim.request('nvim_command', ['set noswapfile nobackup nowritebackup noundofile']);

  // ---- 1. :e /host/fixture.txt reads the file from the server's disk ---------
  await nvim.request('nvim_cmd', [{ cmd: 'edit', args: ['/host/fixture.txt'] }, {}]);
  const lines = await nvim.request('nvim_buf_get_lines', [0, 0, -1, false]);
  // FIXTURE has a trailing newline -> 3 content lines (nvim drops the trailing).
  ok(Array.isArray(lines) && lines.length === 3 &&
     lines[0] === 'line one' && lines[1] === 'line two' && lines[2] === 'line three',
     ':e /host/fixture.txt reads the on-disk file (got ' + JSON.stringify(lines) + ')');

  const bufname = await nvim.request('nvim_eval', ['bufname("%")']);
  ok(/\/host\/fixture\.txt$/.test(bufname), 'the buffer name is the /host path (' + bufname + ')');

  // ---- 2. edit the buffer + :w persists to the on-disk file ------------------
  await nvim.request('nvim_buf_set_lines', [0, 0, -1, false, ['EDITED first', 'line two', 'line three', 'NEW last']]);
  await nvim.request('nvim_cmd', [{ cmd: 'write' }, {}]);
  // Re-read the file FROM DISK in this test process.
  const wrote = await waitFor(async function () {
    const onDisk = fs.readFileSync(path.join(realRoot, 'fixture.txt'), 'utf8');
    return onDisk.indexOf('EDITED first') === 0 && onDisk.indexOf('NEW last') >= 0;
  }, 8000);
  const diskNow = fs.readFileSync(path.join(realRoot, 'fixture.txt'), 'utf8');
  ok(wrote, ':w persists the edit to the server disk (on-disk now: ' + JSON.stringify(diskNow) + ')');

  // ---- 3. :w /host/new.txt creates a NEW file on disk inside root ------------
  await nvim.request('nvim_buf_set_lines', [0, 0, -1, false, ['brand new file', 'second line']]);
  await nvim.request('nvim_cmd', [{ cmd: 'write', args: ['/host/new.txt'] }, {}]);
  const created = await waitFor(async function () {
    return fs.existsSync(path.join(realRoot, 'new.txt'));
  }, 8000);
  ok(created, ':w /host/new.txt creates the file on disk inside root');
  if (created) {
    const newContents = fs.readFileSync(path.join(realRoot, 'new.txt'), 'utf8');
    ok(newContents.indexOf('brand new file') === 0,
       'the new file has the buffer contents (' + JSON.stringify(newContents) + ')');
  }

  // ---- 4. directory listing exercises getdents (glob /host/*) ----------------
  // glob() over /host/* funnels through readdir -> our __syscall_getdents64.
  const globbed = await nvim.request('nvim_call_function', ['glob', ['/host/*', false, true]]);
  ok(Array.isArray(globbed), 'glob(/host/*) returns a list');
  const names = (globbed || []).map(function (p) { return p.split('/').pop(); });
  ok(names.indexOf('fixture.txt') >= 0 && names.indexOf('subdir') >= 0 && names.indexOf('new.txt') >= 0,
     'glob(/host/*) lists the real directory entries via getdents (got ' + JSON.stringify(names) + ')');

  // A nested directory listing too (proves getdents on a subdir + drain).
  const innerGlob = await nvim.request('nvim_call_function', ['glob', ['/host/subdir/*', false, true]]);
  const innerNames = (innerGlob || []).map(function (p) { return p.split('/').pop(); });
  ok(innerNames.indexOf('inner.txt') >= 0,
     'glob(/host/subdir/*) lists the nested entry (got ' + JSON.stringify(innerNames) + ')');

  // ---- 5. JAIL: a /host/../escape and an abs path outside root are denied -----
  // Try to read the outside secret via path traversal. The jail must deny it, so
  // readfile() returns empty / the buffer must NOT contain the secret.
  const escapeRel = '/host/../' + path.basename(realOutside) + '/secret.txt';
  let escapeLeaked = false;
  try {
    const escLines = await nvim.request('nvim_call_function', ['readfile', [escapeRel]]);
    if (Array.isArray(escLines) && escLines.join('\n').indexOf('TOP SECRET') >= 0) {
      escapeLeaked = true;
    }
  } catch (e) { /* an error is an acceptable denial */ }
  ok(!escapeLeaked, 'jail denies /host/../<outside>/secret.txt traversal (no leak)');

  // Also confirm the secret file itself is untouched/unreadable through the mount
  // via an absolute escape attempt routed through the mount-relative resolver.
  let absLeaked = false;
  try {
    // glob the parent of root through traversal; if the jail held, no outside
    // entry shows. (We can only address paths under /host; this asserts traversal
    // out of root yields nothing.)
    const escGlob = await nvim.request('nvim_call_function', ['glob', ['/host/../*', false, true]]);
    const escNames = (escGlob || []).map(function (p) { return p.split('/').pop(); });
    // The outside dir basename must NOT be listable through the mount.
    if (escNames.indexOf(path.basename(realOutside)) >= 0) { absLeaked = true; }
  } catch (e) { /* denial is fine */ }
  ok(!absLeaked, 'jail denies listing the parent of root through /host/../ (no escape)');

  // ---- 6. HARD INVARIANT spot-check: a NON-mount path still uses MEMFS --------
  // Writing/reading a /tmp path inside the engine must NOT touch the server disk
  // (it is plain MEMFS), proving the override delegates for non-mount paths.
  await nvim.request('nvim_call_function', ['writefile', [['memfs only'], '/tmp/local-only.txt']]);
  const memLines = await nvim.request('nvim_call_function', ['readfile', ['/tmp/local-only.txt']]);
  ok(Array.isArray(memLines) && memLines[0] === 'memfs only',
     'a non-mount /tmp path round-trips through MEMFS (delegates, no proxy)');
  ok(!fs.existsSync(path.join(realRoot, 'tmp', 'local-only.txt')) &&
     !fs.existsSync(path.join(realRoot, 'local-only.txt')),
     'the non-mount write did NOT touch the server disk (additive/opt-in invariant)');

  // ---- teardown -------------------------------------------------------------
  worker.terminate();
  await new Promise(function (resolve) { srv.wss.close(function () { srv.httpServer.close(resolve); }); });
  try { fs.rmSync(realRoot, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(realOutside, { recursive: true, force: true }); } catch (e) {}

  console.log('');
  if (failures) { console.log(failures + ' of ' + checks + ' fs-proxy check(s) FAILED'); process.exit(1); }
  console.log('all fs-proxy checks passed (' + checks + ' checks)');
  process.exit(0);
}

main().catch(function (e) { fatal((e && e.stack) || String(e)); });
