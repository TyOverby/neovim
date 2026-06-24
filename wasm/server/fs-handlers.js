// wasm/server/fs-handlers.js - the server-side filesystem proxy handlers
// (Stage 4, Phase 2 -- seam 1). Registered onto the proxy server's handler
// registry by registerFsHandlers(registry); implemented with Node `fs`.
//
// ============================================================================
// PROTOCOL (mirrors wasm/nvim_fs_proxy.js)
// ============================================================================
//   fs.open    {path, flags, mode}            -> {handle, size, isDir}
//   fs.read    {handle?, path, pos, len}      -> {result:{n,eof}, payload:<bytes>}
//   fs.write   {handle?, path, pos} +payload  -> {n}
//   fs.close   {handle}                       -> {ok}
//   fs.stat    {path}                         -> {exists, isDir, size, mode, mtime}
//   fs.lstat   {path}                         -> {exists, isDir, isLink, size, mode, mtime}
//   fs.readdir {path}                         -> {entries:[{name,isDir}, ...]}
//   fs.mkdir   {path, mode}                   -> {ok}
//   fs.unlink  {path, dir:bool}               -> {ok}
//   fs.rename  {from, to}                     -> {ok}
//
// Every `path` is MOUNT-RELATIVE; we resolve it against ctx.config.root and the
// jail check below guarantees it cannot escape that root.
//
// ============================================================================
// JAIL (security, load-bearing -- see stage4.md "Security model")
// ============================================================================
// resolveJailed(root, rel) does path.resolve(root, '.'+rel) (rel is always a
// leading-slash, server-relative path; the '.' join keeps it INSIDE root and
// stops an absolute `rel` from escaping), then verifies the result is within the
// realpath'd root -- rejecting `..` traversal AND symlink escapes. We realpath
// the *nearest existing ancestor* (the leaf may not exist yet, e.g. `:w newfile`)
// and require it to stay under the realpath'd root. Nothing outside root is ever
// touched: a failed jail check throws before any fs call.
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// open(2) flag bits (musl/Linux values, the ones nvim's wasm passes through).
const O_ACCMODE = 0x3;
const O_RDONLY = 0x0, O_WRONLY = 0x1, O_RDWR = 0x2;
const O_CREAT = 0x40, O_EXCL = 0x80, O_TRUNC = 0x200, O_APPEND = 0x400;

// A per-connection handle table lives on ctx (created lazily). Stateless-by-path
// would also work, but a handle table lets us keep O_APPEND / position semantics
// and avoids re-resolving + re-jailing the path on every read/write.
function handleTable(ctx) {
  if (!ctx.__fsHandles) {
    ctx.__fsHandles = { next: 1, byId: Object.create(null) };
  }
  return ctx.__fsHandles;
}

function jailError(msg) {
  const e = new Error(msg);
  e.errno = 13; // EACCES
  return e;
}

// Realpath the nearest existing ancestor of `p`. The leaf (and any missing
// parents) may not exist yet -- that's fine for `:w newfile`. We walk up until
// fs.realpathSync succeeds, then re-append the non-existent tail.
function realpathExistingPrefix(p) {
  let cur = p;
  const tail = [];
  // Guard against an infinite loop at the filesystem root.
  for (let i = 0; i < 4096; i++) {
    try {
      const real = fs.realpathSync(cur);
      // Re-append the tail segments we peeled off (none of them exist, so they
      // can't be symlinks; plain join is safe).
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (e) {
      const parent = path.dirname(cur);
      if (parent === cur) {
        // Reached the root with nothing resolvable -> use it as-is.
        return p;
      }
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  return p;
}

// Resolve a mount-relative path against the jail root and verify it stays inside.
// `rel` is always a server-relative path (leading '/'), e.g. '/' or '/a/b.txt'.
function resolveJailed(root, rel) {
  if (!root) { throw jailError('fs proxy: no jail root configured'); }
  if (typeof rel !== 'string') { rel = '/'; }
  // Join as a RELATIVE segment under root: strip leading slashes so an absolute
  // `rel` cannot replace root, then resolve. `..` is collapsed by resolve and
  // caught by the containment check below.
  const relClean = rel.replace(/^[/\\]+/, '');
  const candidate = path.resolve(root, relClean);

  // Realpath both the root and the candidate's existing prefix, then require the
  // candidate to equal the root or sit under `root + sep`. This catches both
  // `..` traversal and symlink escapes (a symlink pointing outside root resolves
  // to an outside realpath and is rejected).
  let realRoot;
  try { realRoot = fs.realpathSync(root); }
  catch (e) { realRoot = path.resolve(root); }
  const realCandidate = realpathExistingPrefix(candidate);

  const withSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (realCandidate !== realRoot && realCandidate.indexOf(withSep) !== 0) {
    throw jailError("fs proxy: path '" + rel + "' escapes the jail root");
  }
  return realCandidate;
}

// Map a Node fs.Stats into the {exists, isDir, size, mode, mtime} shape the
// wasm side fills a struct stat from. `mode` is the FULL st_mode (type bits +
// perms), so S_IFREG / S_IFDIR survive to the wasm doStat.
function statShape(st, isLstat) {
  return {
    exists: true,
    isDir: st.isDirectory(),
    isLink: isLstat ? st.isSymbolicLink() : false,
    size: st.size,
    mode: st.mode,
    mtime: st.mtimeMs,
  };
}

function registerFsHandlers(registry) {
  // fs.open: resolve+jail, open the file (honoring CREAT/TRUNC/APPEND/RDWR), and
  // return a per-connection handle + the current size + isDir. nvim opens dirs
  // too (to getdents them) -- for a directory we DON'T fs.open (Node can't read()
  // a dir fd portably); we just return a handle marked isDir and serve readdir.
  registry.register('fs.open', async function (params, payload, ctx) {
    const p = resolveJailed(ctx.config.root, params.path);
    const flags = params.flags | 0;

    // Stat first: directories take the no-fd path; missing files without O_CREAT
    // error with ENOENT.
    let st = null;
    try { st = await fsp.stat(p); } catch (e) { /* may not exist */ }

    if (st && st.isDirectory()) {
      const tbl = handleTable(ctx);
      const id = tbl.next++;
      tbl.byId[id] = { path: p, fd: null, isDir: true };
      return { result: { handle: id, size: st.size, isDir: true } };
    }

    // Build the Node open flags string from the musl flag bits.
    const acc = flags & O_ACCMODE;
    let nodeFlags;
    if (flags & O_APPEND) {
      nodeFlags = (acc === O_RDONLY) ? 'a+' : 'a';
    } else if (flags & O_CREAT) {
      if (flags & O_EXCL) { nodeFlags = (acc === O_RDONLY || acc === O_RDWR) ? 'wx+' : 'wx'; }
      else if (flags & O_TRUNC) { nodeFlags = (acc === O_RDONLY || acc === O_RDWR) ? 'w+' : 'w'; }
      else { nodeFlags = (acc === O_WRONLY) ? 'a' : 'r+'; }
      // For O_CREAT without TRUNC on a read/write open of a possibly-missing file,
      // 'r+' fails if absent. Fall back to creating it.
      if (nodeFlags === 'r+' && !st) { nodeFlags = (acc === O_RDONLY) ? 'r' : 'w+'; }
    } else if (acc === O_RDONLY) {
      nodeFlags = 'r';
    } else if (acc === O_WRONLY) {
      nodeFlags = (flags & O_TRUNC) ? 'w' : 'r+';
    } else { // O_RDWR
      nodeFlags = (flags & O_TRUNC) ? 'w+' : 'r+';
    }

    const mode = (typeof params.mode === 'number' && params.mode) ? params.mode : 0o644;
    let fh;
    try {
      fh = await fsp.open(p, nodeFlags, mode);
    } catch (e) {
      e.errno = e.errno || 2;
      throw e;
    }
    let size = 0;
    try { const s2 = await fh.stat(); size = s2.size; } catch (e) { /* ignore */ }

    const tbl = handleTable(ctx);
    const id = tbl.next++;
    tbl.byId[id] = { path: p, fh: fh, isDir: false };
    return { result: { handle: id, size: size, isDir: false } };
  });

  // fs.read: read `len` bytes from `pos`. Prefer the handle's open fd; fall back
  // to the path (stateless) if no handle was supplied. Bytes ride the payload.
  registry.register('fs.read', async function (params, payload, ctx) {
    const len = Math.max(0, params.len | 0);
    const pos = Math.max(0, params.pos | 0);
    const buf = Buffer.allocUnsafe(len);
    let n = 0;
    const tbl = handleTable(ctx);
    const h = (params.handle != null) ? tbl.byId[params.handle] : null;
    if (h && h.fh) {
      const res = await h.fh.read(buf, 0, len, pos);
      n = res.bytesRead;
    } else {
      // Stateless path read (no handle): open, pread, close.
      const p = resolveJailed(ctx.config.root, params.path);
      const fh = await fsp.open(p, 'r');
      try { const res = await fh.read(buf, 0, len, pos); n = res.bytesRead; }
      finally { await fh.close(); }
    }
    const out = n === len ? buf : buf.subarray(0, n);
    return { result: { n: n, eof: n < len }, payload: out };
  });

  // fs.write: write the payload bytes at `pos`. Returns the count written.
  registry.register('fs.write', async function (params, payload, ctx) {
    const bytes = payload || Buffer.alloc(0);
    const pos = Math.max(0, params.pos | 0);
    const tbl = handleTable(ctx);
    const h = (params.handle != null) ? tbl.byId[params.handle] : null;
    let n = 0;
    if (h && h.fh) {
      const res = await h.fh.write(bytes, 0, bytes.length, pos);
      n = res.bytesWritten;
    } else {
      const p = resolveJailed(ctx.config.root, params.path);
      const fh = await fsp.open(p, 'r+').catch(function () { return fsp.open(p, 'w+'); });
      try { const res = await fh.write(bytes, 0, bytes.length, pos); n = res.bytesWritten; }
      finally { await fh.close(); }
    }
    return { result: { n: n } };
  });

  // fs.close: close the handle's fd (if any) and drop it from the table.
  registry.register('fs.close', async function (params, payload, ctx) {
    const tbl = handleTable(ctx);
    const h = (params.handle != null) ? tbl.byId[params.handle] : null;
    if (h) {
      delete tbl.byId[params.handle];
      if (h.fh) { try { await h.fh.close(); } catch (e) { /* already gone */ } }
    }
    return { result: { ok: true } };
  });

  // fs.stat: follow symlinks. Missing -> {exists:false} (NOT an error; nvim
  // stats nonexistent paths constantly while probing).
  registry.register('fs.stat', async function (params, payload, ctx) {
    const p = resolveJailed(ctx.config.root, params.path);
    try {
      const st = await fsp.stat(p);
      return { result: statShape(st, false) };
    } catch (e) {
      return { result: { exists: false } };
    }
  });

  // fs.lstat: do NOT follow symlinks (so a symlink reports as a link).
  registry.register('fs.lstat', async function (params, payload, ctx) {
    const p = resolveJailed(ctx.config.root, params.path);
    try {
      const st = await fsp.lstat(p);
      return { result: statShape(st, true) };
    } catch (e) {
      return { result: { exists: false } };
    }
  });

  // fs.readdir: list the directory's entries with an isDir flag each. We use
  // withFileTypes so we don't lstat each child separately.
  registry.register('fs.readdir', async function (params, payload, ctx) {
    const p = resolveJailed(ctx.config.root, params.path);
    const dirents = await fsp.readdir(p, { withFileTypes: true });
    const entries = dirents.map(function (d) {
      let isDir = d.isDirectory();
      // A symlink-to-dir should list as a dir for nvim's browser; resolve it.
      if (d.isSymbolicLink()) {
        try { isDir = fs.statSync(path.join(p, d.name)).isDirectory(); }
        catch (e) { isDir = false; }
      }
      return { name: d.name, isDir: isDir };
    });
    return { result: { entries: entries } };
  });

  // fs.mkdir: create a directory (single level; nvim mkdirs parents itself).
  registry.register('fs.mkdir', async function (params, payload, ctx) {
    const p = resolveJailed(ctx.config.root, params.path);
    const mode = (typeof params.mode === 'number' && params.mode) ? (params.mode & 0o777) : 0o755;
    await fsp.mkdir(p, { mode: mode });
    return { result: { ok: true } };
  });

  // fs.unlink: remove a file, or rmdir a directory when dir:true.
  registry.register('fs.unlink', async function (params, payload, ctx) {
    const p = resolveJailed(ctx.config.root, params.path);
    if (params.dir) { await fsp.rmdir(p); }
    else { await fsp.unlink(p); }
    return { result: { ok: true } };
  });

  // fs.rename: both paths jailed independently.
  registry.register('fs.rename', async function (params, payload, ctx) {
    const from = resolveJailed(ctx.config.root, params.from);
    const to = resolveJailed(ctx.config.root, params.to);
    await fsp.rename(from, to);
    return { result: { ok: true } };
  });
}

module.exports = {
  registerFsHandlers: registerFsHandlers,
  resolveJailed: resolveJailed,   // exported for the jail unit test
};
