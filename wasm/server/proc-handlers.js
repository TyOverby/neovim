// wasm/server/proc-handlers.js - the server-side process-spawn proxy handlers
// (Stage 4, Phase 3 -- seam 2). Registered onto the proxy server's handler
// registry by registerProcHandlers(registry); implemented with Node
// child_process.spawn.
//
// ============================================================================
// PROTOCOL (mirrors wasm/nvim_proc_proxy.js)
// ============================================================================
//   proc.spawn       {argv:[...], cwd, env:{...}, wantIn, wantOut, wantErr}
//                       -> {id}            (server child id, per connection)
//   proc.stdin       {id} + payload<bytes> -> {ok}      (write child stdin)
//   proc.stdin_close {id}                  -> {ok}      (close child stdin / EOF)
//   proc.kill        {id, signal}          -> {ok}
//   server pushes (ctx.push):
//     proc.stdout {id} + payload<bytes>    (child stdout chunk)
//     proc.stderr {id} + payload<bytes>    (child stderr chunk)
//     proc.exit   {id, code, signal}       (child exited)
//
// ============================================================================
// SECURITY (load-bearing -- see stage4.md "Security model")
// ============================================================================
// A spawn runs a REAL command on the host with the server's privileges -- this is
// a remote-code-execution surface by design (the single-user "edit my own box"
// model). The server binds 127.0.0.1 only. What we DO enforce here:
//   * the child's cwd is JAILED to ctx.config.root (resolveJailed, reused from
//     fs-handlers) -- a relative or `..` cwd cannot escape the project root, and
//     a child started with no cwd defaults to the jail root, never the server's;
//   * children are tracked PER CONNECTION and killed when the connection drops
//     (cleanupConnection), so a closed tab/worker can't leave orphans running.
// We do NOT jail the executable itself or its argv (a shell job legitimately runs
// arbitrary programs on PATH); the jail is the cwd + the loopback bind, matching
// the documented model.
'use strict';

const { spawn } = require('child_process');
// resolveCwd is shared with pty-handlers (mount-aware: maps the mount prefix to
// the jail root, defaults non-mount/MEMFS cwds to the root). See fs-handlers.js.
const { resolveCwd, childEnv } = require('./fs-handlers.js');

// Per-connection child table lives on ctx (created lazily).
function childTable(ctx) {
  if (!ctx.__procChildren) {
    ctx.__procChildren = { next: 1, byId: Object.create(null) };
  }
  return ctx.__procChildren;
}

function registerProcHandlers(registry) {
  // proc.spawn: start the child, stream stdout/stderr back as pushes, and push
  // proc.exit on close. Returns the per-connection child id synchronously-ish
  // (the spawn itself is async to Node, but child_process.spawn returns a handle
  // immediately and 'error' is reported via proc.exit if the binary is missing).
  registry.register('proc.spawn', function (params, payload, ctx) {
    const argv = Array.isArray(params.argv) ? params.argv : [];
    if (argv.length === 0) {
      const e = new Error('proc.spawn: empty argv');
      e.errno = 22;
      throw e;
    }
    const file = argv[0];
    const args = argv.slice(1);

    let cwd;
    try {
      cwd = resolveCwd(ctx, params.cwd);
    } catch (e) {
      // Jail violation (or unresolvable cwd): fail the spawn so nvim completes.
      throw e;
    }

    // Env: the client sends an explicit env dict or null (inherit). The browser
    // engine sends no PATH, so childEnv backfills the server's PATH (else a bare
    // command — e.g. `sh` for `:!` — fails execvp on the server). See fs-handlers.
    const env = childEnv(params);

    const tbl = childTable(ctx);
    const id = tbl.next++;

    const stdio = [
      params.wantIn ? 'pipe' : 'ignore',
      params.wantOut ? 'pipe' : 'ignore',
      params.wantErr ? 'pipe' : 'ignore',
    ];

    let child;
    try {
      child = spawn(file, args, { cwd: cwd, env: env, stdio: stdio });
    } catch (e) {
      // Synchronous spawn failure (rare; most surface via 'error' async).
      throw e;
    }

    const rec = { id: id, child: child, exited: false };
    tbl.byId[id] = rec;

    if (params.wantOut && child.stdout) {
      child.stdout.on('data', function (buf) {
        ctx.push('proc.stdout', { id: id }, buf);
      });
      child.stdout.on('end', function () {
        ctx.push('proc.stdout_close', { id: id });
      });
    }
    if (params.wantErr && child.stderr) {
      child.stderr.on('data', function (buf) {
        ctx.push('proc.stderr', { id: id }, buf);
      });
      child.stderr.on('end', function () {
        ctx.push('proc.stderr_close', { id: id });
      });
    }

    // A failure to even launch (ENOENT for a missing binary) arrives as 'error'.
    // Report it as a non-zero exit (127, the conventional "command not found")
    // so nvim's job machinery completes rather than hangs.
    child.on('error', function (err) {
      if (rec.exited) { return; }
      rec.exited = true;
      ctx.push('proc.exit', { id: id, code: 127, signal: 0 });
    });

    child.on('exit', function (code, signal) {
      if (rec.exited) { return; }
      rec.exited = true;
      // Node gives EITHER code (number) OR signal (string name) -- never both.
      const sig = signal ? signalNumber(signal) : 0;
      ctx.push('proc.exit', { id: id, code: (code == null ? 0 : code), signal: sig });
    });

    return { result: { id: id } };
  });

  // proc.stdin: write the payload bytes to the child's stdin.
  registry.register('proc.stdin', function (params, payload, ctx) {
    const tbl = childTable(ctx);
    const rec = tbl.byId[params.id];
    if (rec && rec.child && rec.child.stdin && rec.child.stdin.writable) {
      try { rec.child.stdin.write(payload || Buffer.alloc(0)); } catch (e) { /* closed */ }
    }
    return { result: { ok: true } };
  });

  // proc.stdin_close: end the child's stdin (EOF), e.g. so `cat` flushes + exits.
  registry.register('proc.stdin_close', function (params, payload, ctx) {
    const tbl = childTable(ctx);
    const rec = tbl.byId[params.id];
    if (rec && rec.child && rec.child.stdin) {
      try { rec.child.stdin.end(); } catch (e) { /* already closed */ }
    }
    return { result: { ok: true } };
  });

  // proc.kill: send a signal to the child.
  registry.register('proc.kill', function (params, payload, ctx) {
    const tbl = childTable(ctx);
    const rec = tbl.byId[params.id];
    if (rec && rec.child && !rec.exited) {
      const sig = signalName(params.signal) || 'SIGTERM';
      try { rec.child.kill(sig); } catch (e) { /* already gone */ }
    }
    return { result: { ok: true } };
  });
}

// Kill every still-running child of a connection (called when the ws drops, so a
// closed tab/worker leaves no orphans). Best-effort.
function cleanupConnection(ctx) {
  if (!ctx.__procChildren) { return; }
  const byId = ctx.__procChildren.byId;
  for (const id of Object.keys(byId)) {
    const rec = byId[id];
    if (rec && rec.child && !rec.exited) {
      try { rec.child.kill('SIGKILL'); } catch (e) { /* ignore */ }
    }
  }
}

// ---- signal name/number helpers --------------------------------------------
// nvim sends a numeric signal (SIGTERM=15, SIGKILL=9); Node's child.kill wants a
// name. And on exit Node gives a signal NAME which we map back to a number for
// the proc.exit push (so the wasm side computes 128+signal like libuv).
const SIGNALS = {
  1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 9: 'SIGKILL',
  13: 'SIGPIPE', 15: 'SIGTERM',
};
function signalName(num) {
  return SIGNALS[num | 0] || null;
}
function signalNumber(name) {
  for (const k of Object.keys(SIGNALS)) {
    if (SIGNALS[k] === name) { return k | 0; }
  }
  // Fall back to Node's os.constants if present (covers signals not in the map).
  try {
    const c = require('os').constants.signals;
    if (c && typeof c[name] === 'number') { return c[name]; }
  } catch (e) { /* ignore */ }
  return 0;
}

module.exports = {
  registerProcHandlers: registerProcHandlers,
  cleanupConnection: cleanupConnection,
};
