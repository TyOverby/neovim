// wasm/web/lsp-proxy.test.js - END-TO-END test of Stage 4 / Phase 4: proxying
// uv_spawn at the LIBUV layer so vim.system() AND the LSP client (which spawn
// children via uv.spawn / luv, NOT nvim's Proc layer) run on the IO-proxy SERVER.
//
// Boots the real Neovim wasm engine (build-wasm/bin/nvim.js in a Node
// worker_thread via wasm/worker.js) WITH a proxy config, starts the real
// server.js on a loopback port jailed to a tmpdir, and asserts:
//
//   1. vim.system({'echo','hi'}):wait()  -> code 0, stdout "hi\n"  (proves the
//      uv_spawn proxy DIRECTLY -- vim.system goes uv.spawn -> uv_spawn, bypassing
//      the Phase 3 Proc proxy entirely);
//   2. an LSP client started with cmd = {'node', <fixture abs path on server>}
//      reaches `initialized` (on_init fires + server_capabilities populated), a
//      textDocument/hover request round-trips (returns HOVER_FROM_FAKE_LSP), and
//      vim.lsp.stop_client tears the client down cleanly.
//
// The fixture language server (wasm/server/fixtures/fake-lsp.js) runs ON THE
// SERVER (the server IS node, so it can run `node <fixture>`); we point the LSP
// cmd at the fixture's absolute path on the server's disk. The proc handler jails
// the child's CWD to --root but NOT the executable/argv (a shell job legitimately
// runs arbitrary programs), so an absolute fixture path resolves fine.
//
// Run:  node wasm/web/lsp-proxy.test.js   (Node >= 24, or >= 22 with --jspi flag)
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
const FIXTURE = path.resolve(__dirname, '..', 'server', 'fixtures', 'fake-lsp.js');

let failures = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) { console.log('  ok   - ' + msg); }
  else { failures++; console.log('  FAIL - ' + msg); }
}
function fatal(msg) { console.error('lsp-proxy: ' + msg); process.exit(1); }
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
  if (!fs.existsSync(FIXTURE)) { fatal('missing fixture ' + FIXTURE); }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nvim-lspproxy-'));
  const realRoot = fs.realpathSync(tmpRoot);

  const srv = serverMod.createServer({ root: realRoot });
  await new Promise(function (resolve) { srv.httpServer.listen(0, '127.0.0.1', resolve); });
  const port = srv.httpServer.address().port;
  const wsUrl = 'ws://127.0.0.1:' + port + '/proxy';
  console.log('# server jailed to ' + realRoot + ' on ' + wsUrl);
  console.log('# fixture LSP at ' + FIXTURE);

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
  // 1. vim.system({'echo','hi'}):wait() -> code 0, stdout "hi\n"
  //    This is the DIRECT proof of the uv_spawn proxy: vim.system goes
  //    uv.spawn -> uv_spawn (luv), NOT through nvim's Proc layer.
  // ==========================================================================
  // A bounded :wait() so a (hypothetical) broken stdio path surfaces as a test
  // failure rather than a hang.
  const sys = await lua(nvim, [
    'local obj = vim.system({ "echo", "hi" }, { text = true }):wait(10000)',
    'return { code = obj.code, signal = obj.signal, stdout = obj.stdout, stderr = obj.stderr }',
  ].join('\n'));
  ok(sys && sys.code === 0, 'vim.system echo: code == 0 (got ' + (sys && sys.code) + ')');
  ok(sys && sys.stdout === 'hi\n',
     'vim.system echo: stdout == "hi\\n" (got ' + JSON.stringify(sys && sys.stdout) + ')');

  // A second vim.system to confirm stdin + EOF + a non-trivial round-trip (cat):
  // the stdin string is written, then vim.system shuts down + closes stdin, which
  // our virtual-fd close op turns into proc.stdin_close -> cat sees EOF and exits.
  const sysCat = await lua(nvim, [
    'local obj = vim.system({ "cat" }, { stdin = "piped-in\\n", text = true }):wait(10000)',
    'return { code = obj.code, stdout = obj.stdout }',
  ].join('\n'));
  ok(sysCat && sysCat.code === 0 && sysCat.stdout === 'piped-in\n',
     'vim.system cat with stdin: echoes "piped-in\\n" + clean EOF exit (got ' +
     JSON.stringify(sysCat && sysCat.stdout) + ', code ' + (sysCat && sysCat.code) + ')');

  // ==========================================================================
  // 2. LSP: start a client whose server is `node <fixture>` on the SERVER.
  // ==========================================================================
  // The LSP client only needs a NAMED buffer + a root_dir to attach; the buffer
  // name need not be a real openable file. We create an unlisted buffer, name it,
  // and disable swapfiles (a proxied /host swap path is not what we're testing).
  fs.writeFileSync(path.join(realRoot, 'main.txt'), 'hello world\n');

  const clientId = await lua(nvim, [
    'local fixture, srcpath = ...',
    '_G.__lsp = { fixture = fixture }',
    'vim.o.swapfile = false',
    'local bufnr = vim.api.nvim_create_buf(true, false)',
    'vim.api.nvim_buf_set_name(bufnr, srcpath)',
    'vim.api.nvim_set_current_buf(bufnr)',
    'local client_id = vim.lsp.start({',
    '  name = "fake-lsp",',
    '  cmd = { "node", fixture },',
    '  root_dir = "/host",',
    '}, { bufnr = bufnr })',
    '_G.__lsp.client_id = client_id',
    '_G.__lsp.bufnr = bufnr',
    'return client_id',
  ].join('\n'), [FIXTURE, path.join('/host', 'main.txt')]);
  ok(typeof clientId === 'number' && clientId > 0,
     'vim.lsp.start returned a client id (got ' + JSON.stringify(clientId) + ')');

  // Poll until the client is initialized (server_capabilities populated).
  const initialized = await waitFor(async function () {
    const r = await lua(nvim, [
      'local c = vim.lsp.get_client_by_id(_G.__lsp.client_id)',
      'if not c then return false end',
      'return c.initialized == true or (c.server_capabilities ~= nil and c.server_capabilities.hoverProvider ~= nil)',
    ].join('\n'));
    return r === true;
  }, 15000);
  ok(initialized, 'LSP client reached initialized (server_capabilities populated)');

  const caps = await lua(nvim, [
    'local c = vim.lsp.get_client_by_id(_G.__lsp.client_id)',
    'if not c or not c.server_capabilities then return nil end',
    'return c.server_capabilities.hoverProvider',
  ].join('\n'));
  ok(caps === true, 'LSP server advertised hoverProvider capability (got ' + JSON.stringify(caps) + ')');

  // textDocument/hover round-trip: request through the client and assert the
  // fixture's hover text comes back.
  await lua(nvim, [
    '_G.__hover = { done = false, value = nil }',
    'local c = vim.lsp.get_client_by_id(_G.__lsp.client_id)',
    'local params = {',
    '  textDocument = { uri = vim.uri_from_bufnr(_G.__lsp.bufnr) },',
    '  position = { line = 0, character = 0 },',
    '}',
    'c:request("textDocument/hover", params, function(err, result)',
    '  _G.__hover.done = true',
    '  _G.__hover.err = err and vim.inspect(err) or nil',
    '  if result and result.contents then',
    '    _G.__hover.value = type(result.contents) == "table" and result.contents.value or result.contents',
    '  end',
    'end, _G.__lsp.bufnr)',
  ].join('\n'));

  const hoverDone = await waitFor(async function () {
    return (await lua(nvim, 'return _G.__hover.done')) === true;
  }, 15000);
  ok(hoverDone, 'textDocument/hover request completed (callback fired)');

  const hoverValue = await lua(nvim, 'return _G.__hover.value');
  ok(hoverValue === 'HOVER_FROM_FAKE_LSP',
     'textDocument/hover round-tripped the fixture result (got ' + JSON.stringify(hoverValue) + ')');

  // ==========================================================================
  // 3. Clean shutdown: vim.lsp.stop_client and confirm the client goes away.
  // ==========================================================================
  await lua(nvim, 'vim.lsp.stop_client(_G.__lsp.client_id)');
  const stopped = await waitFor(async function () {
    const r = await lua(nvim, [
      'local c = vim.lsp.get_client_by_id(_G.__lsp.client_id)',
      'return c == nil or c.is_stopped and c:is_stopped()',
    ].join('\n'));
    return r === true;
  }, 15000);
  ok(stopped, 'vim.lsp.stop_client tore the client down cleanly');

  // ---- teardown -------------------------------------------------------------
  const disposed = await Promise.race([
    (async function () { worker.terminate(); return 'ok'; })(),
    sleep(8000).then(function () { return 'timeout'; }),
  ]);
  ok(disposed === 'ok', 'engine dispose completes without hanging');

  await new Promise(function (resolve) { srv.wss.close(function () { srv.httpServer.close(resolve); }); });
  try { fs.rmSync(realRoot, { recursive: true, force: true }); } catch (e) {}

  console.log('');
  if (failures) { console.log(failures + ' of ' + checks + ' lsp-proxy check(s) FAILED'); process.exit(1); }
  console.log('all lsp-proxy checks passed (' + checks + ' checks)');
  process.exit(0);
}

main().catch(function (e) { fatal((e && e.stack) || String(e)); });
