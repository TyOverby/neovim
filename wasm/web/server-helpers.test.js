// wasm/web/server-helpers.test.js - unit tests for the shared spawn helpers in
// wasm/server/fs-handlers.js (resolveCwd + childEnv).
//
// These encode two bugs found only by REAL-BROWSER testing of the standalone app
// (the Node e2e suites can't reproduce them: under Node the engine inherits the
// host's cwd + PATH, so both happen to be valid; the BROWSER engine sends a
// mount-prefixed/MEMFS cwd and a synthetic PATH="/"):
//
//   1. resolveCwd must map the in-engine cwd the way the FS proxy maps paths:
//      the mount prefix -> the jail root, a sub-path under the mount -> root/sub,
//      and any non-mount (MEMFS) path -> the root (NOT root/<that>, which does not
//      exist -> the child fails to chdir and execvp reports ENOENT). This is what
//      made `:terminal` (cwd '/host' or '/root') fail while `system()` (no cwd) worked.
//   2. childEnv must APPEND the server's PATH so a bare command (the shell `sh`
//      that `:terminal`/`:!` exec) resolves on the server even though the browser
//      engine sends PATH="/" (or none). Append, so a meaningful engine/user PATH
//      still takes precedence but server binaries always resolve.
//
// Run:  node wasm/web/server-helpers.test.js
'use strict';

const path = require('path');
const { resolveCwd, childEnv } = require('../server/fs-handlers.js');

let checks = 0, failures = 0;
function ok(cond, msg) {
  checks++;
  if (cond) { console.log('  ok   - ' + msg); }
  else { failures++; console.log('  FAIL - ' + msg); }
}

// A jail root that exists (so realpath in resolveJailed succeeds); use this dir's
// parent tree root — any existing dir works. Use the repo's wasm dir.
const ROOT = path.resolve(__dirname, '..');           // .../wasm  (an existing dir)
const ctx = { config: { root: ROOT, mount: '/host' } };

// --- resolveCwd: mount-aware mapping ---------------------------------------
ok(resolveCwd(ctx, '') === ROOT, "resolveCwd('') -> root (empty cwd)");
ok(resolveCwd(ctx, undefined) === ROOT, 'resolveCwd(undefined) -> root');
ok(resolveCwd(ctx, '/host') === ROOT, "resolveCwd('/host') -> root (the mount maps to root)");
ok(resolveCwd(ctx, '/host/web') === path.join(ROOT, 'web'),
   "resolveCwd('/host/web') -> root/web (sub-path under the mount)");
ok(resolveCwd(ctx, '/root') === ROOT,
   "resolveCwd('/root') -> root (a MEMFS path with no server twin defaults to root)");
ok(resolveCwd(ctx, '/tmp/whatever') === ROOT,
   "resolveCwd('/tmp/whatever') -> root (non-mount path defaults to root)");
// a default mount when the hello didn't carry one
ok(resolveCwd({ config: { root: ROOT } }, '/host') === ROOT,
   "resolveCwd defaults mount to '/host' when ctx.config.mount is unset");

// --- childEnv: PATH append --------------------------------------------------
const serverPath = process.env.PATH || '/usr/bin:/bin';
(function () {
  const e = childEnv({ env: { PATH: '/', TERM: 'xterm' } });
  ok(e.PATH === '/' + path.delimiter + serverPath,
     "childEnv appends the server PATH after a synthetic engine PATH='/' (the browser case)");
  ok(e.TERM === 'xterm', 'childEnv preserves other supplied env vars');
})();
(function () {
  const e = childEnv({ env: { HOME: '/root' } });            // no PATH at all
  ok(e.PATH === serverPath, "childEnv uses the server PATH when the engine sends none");
})();
(function () {
  const e = childEnv({ env: null });                          // inherit
  ok(typeof e.PATH === 'string' && e.PATH.length > 0,
     'childEnv(null) inherits the server env (with a PATH)');
})();
(function () {
  const e = childEnv({ env: { PATH: '/opt/mybin' } });        // meaningful user PATH
  ok(e.PATH.indexOf('/opt/mybin') === 0 && e.PATH.indexOf(serverPath) !== -1,
     'childEnv keeps a meaningful engine/user PATH first, server PATH appended');
})();

if (failures) {
  console.log(failures + ' of ' + checks + ' server-helpers check(s) FAILED');
  process.exit(1);
}
console.log('all server-helpers checks passed (' + checks + ' checks)');
