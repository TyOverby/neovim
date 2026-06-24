// wasm/server/pty-handlers.js - the server-side PTY proxy handlers (Stage 4,
// Phase 5 -- seam 2 + resize). Registered onto the proxy server's handler
// registry by registerPtyHandlers(registry); implemented with node-pty.
//
// ============================================================================
// PROTOCOL (mirrors the PTY half of wasm/nvim_proc_proxy.js)
// ============================================================================
//   pty.spawn   {argv:[...], cwd, env:{...}, cols, rows} -> {id}   (per connection)
//   pty.write   {id} + payload<bytes>                    -> {ok}   (terminal input)
//   pty.resize  {id, cols, rows}                         -> {ok}
//   pty.kill    {id, signal}                             -> {ok}
//   server pushes (ctx.push):
//     pty.data  {id} + payload<bytes>                    (pty output -> terminal)
//     pty.exit  {id, code, signal}                       (pty child exited)
//
// A :terminal child is ONE bidirectional pty -- there is no stdout/stderr/stdin
// split (unlike proc-handlers.js). node-pty's onData carries the merged output;
// pty.write feeds the input; onExit ends it.
//
// ============================================================================
// SECURITY (load-bearing -- see stage4.md "Security model")
// ============================================================================
// A pty spawn runs a REAL shell on the host with the server's privileges -- a
// remote-code-execution surface by design (the single-user "edit my own box"
// model; the server binds 127.0.0.1 only). What we enforce here, exactly as the
// proc handlers do:
//   * the pty's cwd is JAILED to ctx.config.root (resolveJailed) -- a relative or
//     `..` cwd cannot escape the project root; no cwd defaults to the jail root;
//   * ptys are tracked PER CONNECTION and killed when the connection drops
//     (cleanupPtys), so a closed tab/worker can't leave orphan shells running.
'use strict';

const path = require('path');
// resolveCwd + childEnv are shared with proc-handlers (mount-aware cwd; PATH
// backfill so the server can exec a bare shell). See fs-handlers.js.
const { resolveCwd, childEnv } = require('./fs-handlers.js');

// node-pty is a NATIVE module installed under wasm/web/node_modules (the web
// bundle's npm dep dir, alongside ws/@msgpack). Resolve it from there so this
// module works regardless of cwd. A clear error if it is missing/unbuilt.
const serve = require('../web/serve.js');
let nodePty;
try {
  nodePty = require(path.join(serve.WEB, 'node_modules', 'node-pty'));
} catch (e) {
  console.error('pty-handlers.js: the `node-pty` npm package is required but not installed/built.');
  console.error('Install it under the web bundle:  ( cd wasm/web && npm install node-pty )');
  console.error('Underlying error: ' + ((e && e.message) || e));
  throw e;
}

// Per-connection pty table lives on ctx (created lazily).
function ptyTable(ctx) {
  if (!ctx.__ptys) {
    ctx.__ptys = { next: 1, byId: Object.create(null) };
  }
  return ctx.__ptys;
}


function registerPtyHandlers(registry) {
  // pty.spawn: forkpty a child on the server, stream its output back as pty.data
  // pushes, and push pty.exit on close. Returns the per-connection pty id.
  registry.register('pty.spawn', function (params, payload, ctx) {
    const argv = Array.isArray(params.argv) ? params.argv : [];
    if (argv.length === 0) {
      const e = new Error('pty.spawn: empty argv');
      e.errno = 22;
      throw e;
    }
    const file = argv[0];
    const args = argv.slice(1);
    const cwd = resolveCwd(ctx, params.cwd);  // may throw (jail violation) -> fails the spawn

    // Env: nvim builds the child env itself (jobstart {env=...} / :terminal), but
    // the browser engine sends no PATH -> childEnv backfills the server's so a bare
    // shell execs. A pty also needs a sane TERM (node-pty defaults xterm-256color).
    const env = childEnv(params);

    const cols = (params.cols | 0) || 80;
    const rows = (params.rows | 0) || 24;

    const tbl = ptyTable(ctx);
    const id = tbl.next++;

    let child;
    try {
      child = nodePty.spawn(file, args, {
        name: env.TERM || 'xterm-256color',
        cols: cols,
        rows: rows,
        cwd: cwd,
        env: env,
      });
    } catch (e) {
      // Synchronous spawn failure (e.g. bad cwd / missing shell). Surface as a
      // non-zero exit so nvim's terminal job completes rather than hangs.
      const e2 = new Error('pty.spawn: ' + ((e && e.message) || e));
      throw e2;
    }

    const rec = { id: id, child: child, exited: false };
    tbl.byId[id] = rec;

    child.onData(function (data) {
      // node-pty hands a string (utf8) by default; send raw bytes downstream so a
      // wide/utf8-split sequence round-trips byte-exactly to the terminal.
      ctx.push('pty.data', { id: id }, Buffer.from(data, 'utf8'));
    });

    child.onExit(function (ev) {
      if (rec.exited) { return; }
      rec.exited = true;
      const code = (ev && typeof ev.exitCode === 'number') ? ev.exitCode : 0;
      const sig = (ev && typeof ev.signal === 'number') ? ev.signal : 0;
      ctx.push('pty.exit', { id: id, code: code, signal: sig });
    });

    return { result: { id: id } };
  });

  // pty.write: feed the payload bytes to the pty as terminal input.
  registry.register('pty.write', function (params, payload, ctx) {
    const tbl = ptyTable(ctx);
    const rec = tbl.byId[params.id];
    if (rec && rec.child && !rec.exited && payload && payload.length) {
      try { rec.child.write(Buffer.from(payload).toString('utf8')); } catch (e) { /* gone */ }
    }
    return { result: { ok: true } };
  });

  // pty.resize: set the pty window size (the proxy analogue of ioctl(TIOCSWINSZ)).
  registry.register('pty.resize', function (params, payload, ctx) {
    const tbl = ptyTable(ctx);
    const rec = tbl.byId[params.id];
    if (rec && rec.child && !rec.exited) {
      const cols = (params.cols | 0) || 1;
      const rows = (params.rows | 0) || 1;
      try { rec.child.resize(cols, rows); } catch (e) { /* gone / invalid */ }
    }
    return { result: { ok: true } };
  });

  // pty.kill: send a signal to the pty child (close path / SIGHUP hangup).
  registry.register('pty.kill', function (params, payload, ctx) {
    const tbl = ptyTable(ctx);
    const rec = tbl.byId[params.id];
    if (rec && rec.child && !rec.exited) {
      const sig = signalName(params.signal);  // node-pty.kill(signal?) takes a name
      try { rec.child.kill(sig || undefined); } catch (e) { /* already gone */ }
    }
    return { result: { ok: true } };
  });
}

// Kill every still-running pty of a connection (called when the ws drops, so a
// closed tab/worker leaves no orphan shells). Best-effort.
function cleanupPtys(ctx) {
  if (!ctx.__ptys) { return; }
  const byId = ctx.__ptys.byId;
  for (const id of Object.keys(byId)) {
    const rec = byId[id];
    if (rec && rec.child && !rec.exited) {
      try { rec.child.kill('SIGKILL'); } catch (e) { /* ignore */ }
    }
  }
}

// nvim sends a numeric signal (SIGHUP=1, SIGTERM=15, SIGKILL=9); node-pty's
// kill(signal) wants a name (or undefined -> SIGHUP, node-pty's default).
const SIGNALS = {
  1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 9: 'SIGKILL',
  13: 'SIGPIPE', 15: 'SIGTERM',
};
function signalName(num) {
  return SIGNALS[num | 0] || null;
}

module.exports = {
  registerPtyHandlers: registerPtyHandlers,
  cleanupPtys: cleanupPtys,
};
