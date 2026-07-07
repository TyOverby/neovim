// wasm/chrome-ext/src/ext-engine-worker.ts - the extension's engine worker
// entry: config-persistence hooks around the stock engine worker.
//
// The offscreen host spawns THIS script instead of engine-worker.js directly.
// It pre-creates self.Module with a preRun hook (engine-worker.js keeps an
// existing Module; nvim.js runs preRun after the FS exists, before main), in
// which it wraps the Emscripten FS operations so every WRITE and DELETE under
// ~/.config/nvim is reported to the host:
//
//   worker -> host:  { kind: 'config-write',  path: <rel>, text }   (on close
//                    of a written file, and the destination of a rename)
//                    { kind: 'config-unlink', path: <rel> }          (unlink /
//                    rename source)
//
// The host persists these (IndexedDB) and seeds them back into every future
// engine via the init message's `filesystem` (read side: the whole config
// tree is materialized in MEMFS before main() runs, so nvim just reads it).
// NOTE: pre.js's own seeding also passes through these hooks, so every boot
// echoes the seeded files back -- the host deduplicates by content.
//
// Needs `FS` in the engine's -sEXPORTED_RUNTIME_METHODS (Module.FS).
'use strict';

(function () {
  const S: any = self as any;
  const CONFIG_DIR = '/root/.config/nvim';

  // Path under the config dir -> relative path, else null. FS callers hand us
  // absolute, normalized paths (the syscall layer resolves before FS.*).
  function relConfig(path: any): string | null {
    if (typeof path !== 'string') { return null; }
    if (path.indexOf(CONFIG_DIR + '/') === 0) { return path.slice(CONFIG_DIR.length + 1); }
    return null;
  }

  function post(msg: any): void {
    try { (postMessage as any)(msg); } catch (_e) {}
  }

  function installHooks(): void {
    const FS = S.Module && S.Module.FS;
    if (!FS) {
      post({ kind: 'stderr', text: 'config-persist: Module.FS unavailable (engine built without FS export?); config will not persist' });
      return;
    }
    const decoder = new TextDecoder();

    function emitWrite(path: string): void {
      const rel = relConfig(path);
      if (rel === null) { return; }
      try {
        post({ kind: 'config-write', path: rel, text: decoder.decode(FS.readFile(path)) });
      } catch (_e) { /* raced with a delete; the unlink hook reports it */ }
    }

    // Mark streams opened for writing under the config dir; report the file
    // on close (content is complete then). Covers :w, writefile(), the
    // pre.js boot seeding -- anything that goes through the FS layer.
    const origOpen = FS.open;
    FS.open = function (path: any, flags: any) {
      const stream = origOpen.apply(FS, arguments as any);
      try {
        const writable = (typeof flags === 'string') ? /[wa+]/.test(flags) : ((flags & 3) !== 0);
        if (writable && stream && relConfig(stream.path) !== null) {
          stream.__nvimCfgWrite = true;
        }
      } catch (_e) {}
      return stream;
    };
    const origClose = FS.close;
    FS.close = function (stream: any) {
      const path = stream && stream.path;
      const written = stream && stream.__nvimCfgWrite;
      const r = origClose.apply(FS, arguments as any);
      if (written) { emitWrite(path); }
      return r;
    };
    const origUnlink = FS.unlink;
    FS.unlink = function (path: any) {
      const r = origUnlink.apply(FS, arguments as any);
      const rel = relConfig(path);
      if (rel !== null) { post({ kind: 'config-unlink', path: rel }); }
      return r;
    };
    // A rename is a delete at the source + a (re)write at the destination;
    // either side may be outside the config dir ('writebackup' shuffles).
    const origRename = FS.rename;
    FS.rename = function (oldPath: any, newPath: any) {
      const r = origRename.apply(FS, arguments as any);
      const relOld = relConfig(oldPath);
      if (relOld !== null) { post({ kind: 'config-unlink', path: relOld }); }
      emitWrite(newPath);
      return r;
    };
  }

  // Pre-create Module so engine-worker.js (S.Module = S.Module || {}) and
  // nvim.js (var Module = existing) adopt it; preRun runs once the FS is up.
  S.Module = S.Module || {};
  S.Module.preRun = S.Module.preRun || [];
  S.Module.preRun.push(installHooks);
})();

importScripts('engine-worker.js');
