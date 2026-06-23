// wasm/pre.js - Emscripten --pre-js for Neovim's wasm build.
//
// Concatenated into nvim.js and executed while the module initializes. It
// configures things Emscripten does not derive on its own:
//   * argv: under Node, the `node nvim.js -- <nvim args>` convention; in any
//     environment, a host may override argv via globalThis.__nvimArgs.
//   * a postMessage RPC channel (globalThis.__nvimChannel), for the engine role
//     (see wasm/nvim_io.js).
//   * $VIMRUNTIME + a minimal environment (Emscripten's ENV does not inherit
//     the host environment).
//
// This file runs in BOTH targets from one binary:
//   * Node (worker_thread engine, or the builtin-TUI client): `process` exists,
//     so we mount the host filesystem via NODEFS and copy across process.env.
//   * Browser (Web Worker engine): no `process`. The runtime ships preloaded
//     into MEMFS at /usr/share/nvim/runtime (--preload-file), and the host page
//     hands us argv + the postMessage channel through globals before the module boots.
(function () {
  var isNode = (typeof process !== 'undefined' &&
                process.versions && process.versions.node);

  // Runtime lives at this MEMFS path in every target: under emcc it is
  // --preload-file'd there; under Node the NODEFS mounts below skip /usr so the
  // preloaded copy is the one that wins.
  var VIMRUNTIME = '/usr/share/nvim/runtime';

  var args = [];
  if (isNode) {
    // argv after a literal `--` (or everything, if there's no `--`).
    args = process.argv.slice(2);
    var sep = args.indexOf('--');
    if (sep !== -1) {
      args = args.slice(sep + 1);
    }
    if (process.env.VIMRUNTIME) {
      VIMRUNTIME = process.env.VIMRUNTIME;
    }
  }

  // A host (the engine worker, Node or browser) overrides argv and supplies the
  // postMessage RPC channel via globals. We read them here because
  // Emscripten's own `var Module` shadows any globalThis.Module a host could set.
  if (typeof globalThis !== 'undefined') {
    if (globalThis.__nvimArgs) {
      args = globalThis.__nvimArgs;
    }
    if (globalThis.__nvimChannel) {
      Module['nvimChannel'] = globalThis.__nvimChannel;
    }
  }
  Module['arguments'] = args;
  // Keep a pristine copy: Emscripten's callMain() does args.unshift(thisProgram),
  // mutating Module['arguments'] in place before user code runs.
  Module['nvimUserArgs'] = args.slice();
  Module['thisProgram'] = '/usr/bin/nvim';
  // (locateFile for the preloaded nvim.data is set in wasm/extern-pre.js, which
  // runs before the data-package loader; --pre-js would be too late.)

  Module['preRun'] = Module['preRun'] || [];
  Module['preRun'].push(function () {
    if (isNode) {
      // Mount the host filesystem. Unlike NODERAWFS, MEMFS+NODEFS keeps fd 0/1 as
      // virtual streams (so they can be backed by the postMessage RPC channel), while real
      // files remain reachable. We mount each existing top-level host directory
      // onto the same path inside the wasm FS. /usr is intentionally skipped so it
      // does not shadow the preloaded runtime at /usr/share/nvim/runtime.
      try {
        var fs = require('fs');
        var NODEFS = FS.filesystems.NODEFS;
        var roots = ['/home', '/etc', '/opt', '/var', '/root', '/mnt',
                     '/tmp', '/srv', '/run'];
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
        // No NODEFS (or mount failed): fall back to plain MEMFS.
      }
    } else {
      // Browser: no host FS. Make sure a couple of writable dirs exist for HOME
      // and temp files (we pass -i NONE, so shada is off, but be safe).
      ['/root', '/tmp'].forEach(function (d) {
        try { FS.mkdir(d); } catch (e) { /* exists */ }
      });
      try { FS.chdir('/root'); } catch (e) { /* stay at / */ }
    }

    // ENV is the Emscripten runtime's environment map (used by getenv()).
    ENV['VIMRUNTIME'] = VIMRUNTIME;
    if (isNode) {
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
    } else {
      ENV['HOME'] = '/root';
      ENV['USER'] = 'web';
      ENV['LOGNAME'] = 'web';
      ENV['PWD'] = '/root';
      ENV['TERM'] = 'xterm-256color';
      ENV['LANG'] = 'C.UTF-8';
    }
  });
})();
