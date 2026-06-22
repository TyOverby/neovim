// wasm/pre.js - Emscripten --pre-js for Neovim's wasm build.
//
// Concatenated into nvim.js and executed while the module initializes (with
// full access to the Node `process`). It configures things Emscripten does not
// derive on its own:
//   * argv: supports the `node nvim.js -- <nvim args>` convention (everything
//     after a literal `--`, or all args if none).
//   * $VIMRUNTIME: defaults to the in-tree runtime/ dir; overridable via env.
//   * environment: Emscripten's ENV starts as fixed "web_user" stubs and does
//     NOT inherit process.env, so we copy across what Neovim/plugins expect.
//
// Usage:  node nvim.js -- [nvim args]      e.g.  node nvim.js -- --headless +qa
(function () {
  if (typeof process === 'undefined') {
    return;  // not running under Node; nothing to configure
  }
  var path = require('path');
  var fs = require('fs');

  // argv after a literal `--` (or everything, if there's no `--`).
  var args = process.argv.slice(2);
  var sep = args.indexOf('--');
  if (sep !== -1) {
    args = args.slice(sep + 1);
  }
  // A host (e.g. the server worker) may override argv and supply a shared-memory
  // RPC channel via globals. We read them here because Emscripten's own
  // `var Module` shadows any globalThis.Module a `require()`-ing host would set.
  if (typeof globalThis !== 'undefined') {
    if (globalThis.__nvimArgs) {
      args = globalThis.__nvimArgs;
    }
    if (globalThis.__nvimServerChannel) {
      Module['nvimServerChannel'] = globalThis.__nvimServerChannel;
      Module['nvimCanBlockSync'] = !!globalThis.__nvimCanBlockSync;
    }
  }
  Module['arguments'] = args;
  // Keep a pristine copy: Emscripten's callMain() does args.unshift(thisProgram),
  // mutating Module['arguments'] in place before user code runs. The wasm client
  // (nvim_wasm_start_engine) needs the original nvim args to pass to the engine.
  Module['nvimUserArgs'] = args.slice();
  Module['thisProgram'] = '/usr/bin/nvim';

  function findRuntime() {
    if (process.env.VIMRUNTIME) {
      return process.env.VIMRUNTIME;
    }
    var dir = (typeof __dirname !== 'undefined') ? __dirname : process.cwd();
    var candidates = [
      path.resolve(dir, '..', '..', 'runtime'),  // build-wasm/bin -> repo/runtime
      path.resolve(dir, 'runtime'),
      path.resolve(dir, '..', 'share', 'nvim', 'runtime'),
    ];
    for (var i = 0; i < candidates.length; i++) {
      try {
        if (fs.existsSync(path.join(candidates[i], 'lua', 'vim', 'version.lua'))) {
          return candidates[i];
        }
      } catch (e) { /* ignore */ }
    }
    return candidates[0];
  }
  var VIMRUNTIME = findRuntime();

  Module['preRun'] = Module['preRun'] || [];
  Module['preRun'].push(function () {
    // Mount the host filesystem. Unlike NODERAWFS, MEMFS+NODEFS keeps fd 0/1 as
    // virtual streams (so they can be backed by the SAB RPC channel), while real
    // files remain reachable. We mount each existing top-level host directory
    // onto the same path inside the wasm FS, so *absolute* host paths
    // ($VIMRUNTIME, the cwd, file arguments) resolve transparently and unchanged.
    try {
      var NODEFS = FS.filesystems.NODEFS;
      var roots = ['/home', '/usr', '/etc', '/opt', '/var', '/root', '/mnt',
                   '/tmp', '/lib', '/lib64', '/bin', '/sbin', '/srv', '/run'];
      for (var r = 0; r < roots.length; r++) {
        var d = roots[r];
        try {
          if (!fs.existsSync(d)) { continue; }
          try { FS.mkdir(d); } catch (e) { /* may already exist (e.g. /tmp) */ }
          FS.mount(NODEFS, { root: d }, d);
        } catch (e) { /* skip dirs we can't mount */ }
      }
      try { FS.chdir(process.cwd()); } catch (e) { /* stay at default cwd */ }
    } catch (e) {
      // No NODEFS (or mount failed): fall back to plain MEMFS. Real file access
      // will be unavailable, but headless/self-contained runs still work.
    }

    // ENV is the Emscripten runtime's environment map (used by getenv()).
    ENV['VIMRUNTIME'] = VIMRUNTIME;
    ENV['PWD'] = process.cwd();
    ENV['TERM'] = process.env.TERM || 'xterm-256color';
    var passthrough = [
      'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'PATH',
      'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
      'XDG_RUNTIME_DIR', 'NVIM_APPNAME', 'COLORTERM', 'NO_COLOR',
      'NVIM_LOG_FILE', '__NVIM_TEST_LOG',
    ];
    for (var j = 0; j < passthrough.length; j++) {
      var k = passthrough[j];
      if (process.env[k] !== undefined) {
        ENV[k] = process.env[k];
      }
    }
  });
})();
