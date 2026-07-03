// wasm/web/treesitter.test.js - tree-sitter parser loading in the wasm engine.
//
// The native build ships the bundled grammars as dlopen()able shared objects
// under lib/nvim/parser/*.so; wasm has no dlopen, so the parsers must be
// statically linked into nvim.wasm and registered as builtins (see
// src/nvim/lua/treesitter.c + the EMSCRIPTEN block in src/nvim/CMakeLists.txt).
// This test locks that path: opening a .lua file must start tree-sitter
// highlighting (runtime/ftplugin/lua.lua calls vim.treesitter.start()
// unconditionally) instead of throwing "Parser could not be created".
//
// Prereqs: a finished wasm/build-nvim.sh (build-wasm/bin/nvim.{js,wasm}).
// Run:  node wasm/web/treesitter.test.js   (Node >= 24, or 22 with
//                                            --experimental-wasm-jspi)
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const NVIM_JS = path.join(ROOT, 'build-wasm', 'bin', 'nvim.js');

// ---- tiny test harness (same shape as e2e.test.js) --------------------------
let failures = 0;
function ok(cond, msg) {
  if (cond) { console.log('  ok   - ' + msg); }
  else { failures++; console.log('  FAIL - ' + msg); }
}
function fatal(msg) { console.error('treesitter: ' + msg); process.exit(1); }

if (!fs.existsSync(NVIM_JS)) { fatal('missing ' + NVIM_JS + ' (run wasm/build-nvim.sh)'); }

// The probe runs INSIDE the wasm engine (nvim -l): it exercises the same code
// path a user hits (:edit file.lua -> ftplugin -> vim.treesitter.start()) and
// reports what happened as one JSON line on stdout.
const PROBE = `
local sample = _G.arg[1]
local out = {}

-- 1. the raw loader: can the bundled lua grammar be registered at all?
local added, add_err = vim.treesitter.language.add('lua')
out.add_ok = added == true
out.add_err = add_err

-- 2. the user path: open a .lua file; ftplugin/lua.lua runs
--    vim.treesitter.start() unconditionally.
local edit_ok, edit_err = pcall(vim.cmd, 'edit ' .. sample)
out.edit_ok = edit_ok
out.edit_err = edit_ok and nil or tostring(edit_err)

if edit_ok then
  local buf = vim.api.nvim_get_current_buf()
  -- grammar applied: the treesitter highlighter attached to the buffer...
  out.highlighter_active = vim.treesitter.highlighter.active[buf] ~= nil
  -- ...the parser actually parses (root node of a lua file is a "chunk")...
  local pok, parser = pcall(vim.treesitter.get_parser, buf, 'lua')
  if pok and parser then
    local tree = parser:parse()[1]
    out.root_type = tree and tree:root():type() or nil
  end
  -- ...and highlight captures resolve at the "local" keyword (row 0, col 0).
  local cok, caps = pcall(vim.treesitter.get_captures_at_pos, buf, 0, 0)
  out.captures = {}
  if cok then
    for _, c in ipairs(caps) do table.insert(out.captures, c.capture) end
  end
end

-- 3. every grammar the native build bundles as parser/<lang>.so must be
--    available (keep in sync with builtin_langs[] in src/nvim/lua/treesitter.c).
out.bundled_failures = {}
for _, l in ipairs({ 'c', 'lua', 'markdown', 'markdown_inline', 'query', 'vim', 'vimdoc' }) do
  local lok = vim.treesitter.language.add(l)
  if lok ~= true then table.insert(out.bundled_failures, l) end
end

-- 4. a grammar that is NOT bundled must still fail cleanly (no false positives
--    from the builtin registry).
local missing_ok, missing_err = vim.treesitter.language.add('nosuchlang')
out.missing_ok = missing_ok == true
out.missing_err = missing_err

io.write('TSRESULT:' .. vim.json.encode(out) .. '\\n')
`;

function runProbe() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvim-wasm-ts-'));
  const probe = path.join(dir, 'probe.lua');
  const sample = path.join(dir, 'sample.lua');
  fs.writeFileSync(probe, PROBE);
  fs.writeFileSync(sample, 'local x = 1\nprint(x)\n');
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [
      NVIM_JS, '--',
      '--clean', '--headless', '-i', 'NONE',
      '--cmd', 'set noswapfile',
      '-l', probe, sample,
    ], {
      encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
      // Keep the engine's $NVIM_LOG_FILE inside the temp dir (the default lands
      // an nvim.log in the test runner's cwd).
      env: Object.assign({}, process.env, { NVIM_LOG_FILE: path.join(dir, 'nvim.log') }),
    });
  } catch (e) {
    // nvim -l exits 0 on success; a nonzero exit still carries our stdout.
    stdout = (e.stdout || '') + '';
    if (!stdout.includes('TSRESULT:')) {
      fatal('engine run failed: ' + e.message + '\n' + (e.stderr || ''));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const line = stdout.split('\n').find(function (l) { return l.startsWith('TSRESULT:'); });
  if (!line) { fatal('no TSRESULT line in engine output:\n' + stdout); }
  return JSON.parse(line.slice('TSRESULT:'.length));
}

console.log('# tree-sitter grammars in the wasm engine');
const r = runProbe();

// The bundled grammar loads.
ok(r.add_ok === true, 'vim.treesitter.language.add("lua") succeeds' +
  (r.add_err ? ' (got error: ' + r.add_err + ')' : ''));

// Opening a .lua file (which unconditionally starts treesitter) does not throw.
ok(r.edit_ok === true, 'opening a .lua file raises no treesitter error' +
  (r.edit_err ? ' (got: ' + r.edit_err + ')' : ''));

// The grammar is APPLIED: highlighter attached, tree parsed, captures resolve.
ok(r.highlighter_active === true, 'treesitter highlighter is active on the buffer');
ok(r.root_type === 'chunk', 'parser produced a syntax tree (root=' + r.root_type + ')');
ok(Array.isArray(r.captures) && r.captures.length > 0,
  'highlight captures resolve at "local" (' + JSON.stringify(r.captures) + ')');

// All seven bundled grammars register.
ok(Array.isArray(r.bundled_failures) && r.bundled_failures.length === 0,
  'all bundled grammars load (failed: ' + JSON.stringify(r.bundled_failures) + ')');

// Unknown grammars still fail cleanly.
ok(r.missing_ok === false && /No parser for language/.test(r.missing_err || ''),
  'a non-bundled grammar still reports "No parser for language"');

if (failures) { console.log(failures + ' check(s) FAILED'); process.exit(1); }
console.log('ALL CHECKS PASSED');
process.exit(0);
