// wasm/nvim_fs_proxy.js - Emscripten JS-library: async, server-backed filesystem
// syscalls for the standalone neovim.js application (Stage 4, Phase 2 -- seam 1).
//
// ============================================================================
// WHAT THIS DOES
// ============================================================================
// When the engine worker is configured with an IO-proxy (globalThis.__nvimProxy,
// set by wasm/web/engine-worker.js / wasm/worker.js) AND a mount prefix
// (globalThis.__nvimProxyMount, e.g. "/host"), Neovim's real file IO under that
// prefix round-trips to the SERVER's real filesystem (jailed to the server's
// --root). Every other path stays MEMFS/NODEFS exactly as today.
//
// Concretely: `:e /host/foo.txt` opens a file that exists only on the server's
// disk; editing + `:w` persists to that disk file; `:e /host/<subdir>/` lists the
// real directory -- all by overriding the file-IO syscalls and routing the
// mount-prefix ones over the proxy connection while the wasm frame suspends via
// JSPI (the same `__async` mechanism wasm/nvim_io.js uses for __syscall_poll).
//
// This is the productionization of de-risking SPIKE A (see the scratchpad
// SPIKE-FINDINGS.md): __async overrides of __syscall_openat / fd_read /
// __syscall_fstat64 / __syscall_newfstatat / __syscall_close, plus fd_write /
// fd_seek / __syscall_getdents64 / __syscall_unlinkat / __syscall_mkdirat /
// __syscall_renameat for the full edit+save+dir-listing path.
//
// ============================================================================
// HARD INVARIANT (binding): ADDITIVE + OPT-IN
// ============================================================================
// With NO proxy mount configured, every override delegates to the current
// default behavior, so MEMFS/NODEFS file IO is byte-for-byte unchanged and NEVER
// suspends. In particular: fd 0/1 (the RPC channel), runtime loads, and all
// non-mount paths behave exactly as today. ONLY a path under the mount prefix
// (or a virtual host fd >= 100000) takes the async server path.
//
// The sync fast paths return a PLAIN INTEGER (never a Promise) -- a Promise on
// the fast path would needlessly suspend every MEMFS open. The async paths
// `return` a Promise and the wasm frame suspends (the override is `__async`).
//
// ============================================================================
// SERVER PROTOCOL (the request methods this calls; handled in wasm/server)
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
// All `path`s are MOUNT-RELATIVE (the mount prefix stripped); the server jails
// them to its --root. Binary file bytes ride the frame's binary payload.
// ============================================================================

addToLibrary({
  // --------------------------------------------------------------------------
  // $HostFS: the shared state + helpers. No __deps on the proxy itself -- it is
  // read lazily off globalThis so the library links cleanly with or without one.
  // --------------------------------------------------------------------------
  $HostFS__deps: ['$FS'],
  $HostFS: {
    nextFd: 100000,   // virtual host fds, well above the MEMFS range
    open: {},         // fd -> { path, pos, flags, handle, size, isDir }

    // Optional debug log to stderr, gated on $NVIM_FS_PROXY_LOG. Never throws.
    dbg: function (m) {
      try {
        if (typeof process !== 'undefined' && process.env && process.env.NVIM_FS_PROXY_LOG) {
          if (typeof err === 'function') { err('[fs-proxy] ' + m); }
        }
      } catch (e) { /* ignore */ }
    },

    // Resolve the proxy + mount from the globals the host sets. Returns null if
    // either is absent -> ALL overrides delegate to default behavior.
    proxy: function () {
      return (typeof globalThis !== 'undefined' && globalThis.__nvimProxy) || null;
    },
    mount: function () {
      var m = (typeof globalThis !== 'undefined' && globalThis.__nvimProxyMount) || null;
      return (typeof m === 'string' && m.length) ? m : null;
    },
    // True when proxying is active AND `path` is under the mount prefix. A bare
    // mount path ("/host") and any child ("/host/...") both count, so `:e /host/`
    // (directory listing of the mount root) works.
    isHostPath: function (path) {
      if (!HostFS.proxy()) { return false; }
      var m = HostFS.mount();
      if (!m || typeof path !== 'string') { return false; }
      if (path === m) { return true; }
      // "/host" matches "/host/..." and "/host/" but not "/hostile".
      return path.indexOf(m + '/') === 0;
    },
    // Strip the mount prefix -> the server-relative path (always leading-slash,
    // server jails it to its root). "/host" -> "/", "/host/a/b" -> "/a/b".
    rel: function (path) {
      var m = HostFS.mount();
      var r = path.slice(m.length);
      if (r === '' || r[0] !== '/') { r = '/' + r; }
      return r;
    },
    isHostFd: function (fd) {
      return fd >= 100000 && HostFS.open[fd] !== undefined;
    },

    // ERRNO VALUES (load-bearing): the hardcoded errno literals below are
    // EMSCRIPTEN/WASI numbers, NOT Linux ones — the engine + its libuv use the
    // musl-wasi table where ENOENT=44, EACCES=2, EIO=29, EINVAL=28, EEXIST=20,
    // EXDEV=75 (NOT the Linux 2/13/5/22/17/18). Returning a Linux errno makes
    // nvim misread the result: e.g. a missing-file stat returning Linux-2 reads
    // as EACCES here, so nvim's `perm == UV_ENOENT` "[New file]" check fails and
    // `:w` on a brand-new host file spuriously errors E45 'readonly'. (`e.errno`
    // read off a thrown FS.ErrnoError is already an emscripten value — only the
    // server-rejection fallback literals needed correcting.)
    //
    // ERRNO HANDLING (load-bearing): our addToLibrary overrides REPLACE the
    // default __syscall_*/fd_* impls, but they do NOT inherit Emscripten's
    // wrapSyscallFunction try/catch that converts a thrown FS.ErrnoError into a
    // numeric -errno (syscalls) / +errno (WASI) return. Because our overrides are
    // __async, an uncaught synchronous throw would become an UNHANDLED rejected
    // Promise and abort the engine. So every SYNC delegate path here must run
    // under HostFS.guard()/guardWasi() to reproduce that conversion ourselves.
    // (e is rethrown if it is not an ErrnoError, matching the default wrapper.)
    guard: function (fn) {      // for __syscall_* (negated errno)
      try { return fn(); }
      catch (e) {
        if (!e || e.name !== 'ErrnoError') { throw e; }
        return -e.errno;
      }
    },
    guardWasi: function (fn) {  // for fd_read/fd_write/fd_seek (positive errno)
      try { return fn(); }
      catch (e) {
        if (!e || e.name !== 'ErrnoError') { throw e; }
        return e.errno;
      }
    },

    // Fill a `struct stat` (offsets from emscripten struct_info: size 96) for a
    // host entry. We model the field writes off SYSCALLS.doStat (a synthetic
    // node + the default offset-correct writer), so layout stays in lockstep with
    // the impl we replace. `info` = { isDir, size, mode?, mtime? } from the server.
    doHostStat: function (info, ino, buf) {
      var S_IFREG = 0x8000, S_IFDIR = 0x4000;
      var mode;
      if (typeof info.mode === 'number' && info.mode) {
        mode = info.mode;
      } else {
        mode = (info.isDir ? (S_IFDIR | 0x1ed /*0755*/) : (S_IFREG | 0x1a4 /*0644*/));
      }
      var size = info.size || 0;
      var mtimeMs = (typeof info.mtime === 'number') ? info.mtime : Date.now();
      var mt = new Date(mtimeMs);
      return SYSCALLS.doStat(function () {
        return {
          dev: 1, ino: ino, mode: mode, nlink: 1, uid: 0, gid: 0,
          rdev: 0, size: size, blocks: Math.ceil(size / 4096),
          atime: mt, mtime: mt, ctime: mt,
        };
      }, '/host', buf);
    },

    // Round-trip a server stat/lstat for a mount-RELATIVE path and fill `buf`.
    // Returns a Promise<int> (0 on success, -ENOENT when the path is absent).
    // Shared by __syscall_stat64 / __syscall_lstat64 / __syscall_newfstatat.
    statHostPath: function (method, rel, buf) {
      var ino = 0;
      for (var i = 0; i < rel.length; i++) { ino = ((ino * 31) + rel.charCodeAt(i)) >>> 0; }
      return HostFS.proxy().request(method, { path: rel }).then(function (resp) {
        var r = resp.result || {};
        if (!r.exists) { return -44; /* -ENOENT */ }
        return HostFS.doHostStat(r, ino || 1, buf);
      }, function () { return -44; });
    },
  },

  // --------------------------------------------------------------------------
  // __syscall_openat (ASYNC): mount-prefix paths round-trip server fs.open and
  // allocate a virtual host fd; everything else is the default synchronous open.
  // --------------------------------------------------------------------------
  __syscall_openat__deps: ['$HostFS', '$FS', '$SYSCALLS', '$syscallGetVarargI'],
  __syscall_openat__async: true,
  __syscall_openat: function (dirfd, path, flags, varargs) {
    var p = SYSCALLS.getStr(path);
    // calculateAt resolves relative paths against dirfd's dir (incl. host dirs:
    // a host fd's stream.path is the host path -- but host dirs are virtual fds
    // with no FS stream, so a relative openat against a host dir fd is not a
    // pattern nvim uses; absolute /host/... and cwd-relative both resolve here).
    var full;
    try { full = SYSCALLS.calculateAt(dirfd, p); }
    catch (e) { full = p; }

    // Prime the variadic `mode`. The async wrapper does NOT prime SYSCALLS.varargs
    // the way the default trampoline does, so set it ourselves before reading.
    var mode = 0;
    if (varargs) { SYSCALLS.varargs = varargs; mode = syscallGetVarargI(); }

    if (!HostFS.isHostPath(full)) {
      // SYNC fast path: must return a plain integer, NOT a Promise. Convert a
      // thrown ErrnoError to -errno ourselves (see HostFS.guard).
      return HostFS.guard(function () { return FS.open(full, flags, mode).fd; });
    }

    // ASYNC path: round-trip the server. Suspends here until it replies.
    var rel = HostFS.rel(full);
    return HostFS.proxy().request('fs.open', { path: rel, flags: flags, mode: mode })
      .then(function (resp) {
        var r = resp.result || {};
        var fd = HostFS.nextFd++;
        HostFS.open[fd] = {
          path: full, rel: rel, pos: 0, flags: flags,
          handle: r.handle, size: r.size || 0, isDir: !!r.isDir,
          // getdents drain state (lazy): the synthesized record buffer + offset.
          dents: null, dentsPos: 0,
        };
        return fd;
      }, function (e) {
        return -(e && e.errno ? e.errno : 44); // -ENOENT
      });
  },

  // --------------------------------------------------------------------------
  // fd_read (ASYNC): host fds round-trip server fs.read; everything else is the
  // default doReadv over the MEMFS stream. The READ seam is fd_read (WASI), NOT
  // __syscall_read (see SPIKE-FINDINGS). Do NOT disturb fd 0/1/MEMFS/NODEFS.
  // --------------------------------------------------------------------------
  fd_read__deps: ['$HostFS', '$FS', '$doReadv', '$SYSCALLS'],
  fd_read__async: true,
  fd_read: function (fd, iov, iovcnt, pnum) {
    if (!HostFS.isHostFd(fd)) {
      // SYNC fast path: replicate the default fd_read exactly (errno -> +errno).
      return HostFS.guardWasi(function () {
        var stream = SYSCALLS.getStreamFromFD(fd);
        var num = doReadv(stream, iov, iovcnt);
        HEAPU32[pnum >> 2] = num;
        return 0;
      });
    }
    // ASYNC host read: ask the server for up to `total` bytes from `pos`.
    var h = HostFS.open[fd];
    var want = 0;
    for (var i = 0; i < iovcnt; i++) { want += HEAPU32[(iov + 8 * i + 4) >> 2]; }
    if (want === 0) { HEAPU32[pnum >> 2] = 0; return 0; }
    return HostFS.proxy().request('fs.read',
      { handle: h.handle, path: h.rel, pos: h.pos, len: want })
      .then(function (resp) {
        var bytes = resp.payload || new Uint8Array(0);
        var total = 0, srcOff = 0;
        for (var j = 0; j < iovcnt && srcOff < bytes.length; j++) {
          var ptr = HEAPU32[(iov + 8 * j) >> 2];
          var len = HEAPU32[(iov + 8 * j + 4) >> 2];
          var take = Math.min(len, bytes.length - srcOff);
          if (take > 0) {
            HEAPU8.set(bytes.subarray(srcOff, srcOff + take), ptr);
            srcOff += take;
            total += take;
          }
          if (take < len) { break; }
        }
        h.pos += total;
        HEAPU32[pnum >> 2] = total;
        return 0;
      }, function () { return -29; /* -EIO */ });
  },

  // --------------------------------------------------------------------------
  // fd_write (ASYNC): host fds round-trip server fs.write (this is what makes
  // `:w` persist); everything else is the default doWritev. Advances pos.
  // --------------------------------------------------------------------------
  fd_write__deps: ['$HostFS', '$FS', '$doWritev', '$SYSCALLS'],
  fd_write__async: true,
  fd_write: function (fd, iov, iovcnt, pnum) {
    if (!HostFS.isHostFd(fd)) {
      // SYNC fast path: replicate the default fd_write exactly (errno -> +errno).
      return HostFS.guardWasi(function () {
        var stream = SYSCALLS.getStreamFromFD(fd);
        var num = doWritev(stream, iov, iovcnt);
        HEAPU32[pnum >> 2] = num;
        return 0;
      });
    }
    // Gather the iovecs into one buffer (copied OUT of the wasm heap -- memory
    // growth can detach it, and the frame suspends across the round-trip).
    var h = HostFS.open[fd];
    var total = 0, k;
    for (k = 0; k < iovcnt; k++) { total += HEAPU32[(iov + 8 * k + 4) >> 2]; }
    var buf = new Uint8Array(total);
    var off = 0;
    for (k = 0; k < iovcnt; k++) {
      var ptr = HEAPU32[(iov + 8 * k) >> 2];
      var len = HEAPU32[(iov + 8 * k + 4) >> 2];
      buf.set(HEAPU8.subarray(ptr, ptr + len), off);
      off += len;
    }
    var writePos = h.pos;
    return HostFS.proxy().request('fs.write',
      { handle: h.handle, path: h.rel, pos: writePos }, buf)
      .then(function (resp) {
        var n = (resp.result && typeof resp.result.n === 'number') ? resp.result.n : total;
        h.pos += n;
        if (h.pos > h.size) { h.size = h.pos; }
        HEAPU32[pnum >> 2] = n;
        return 0;
      }, function () { return -29; /* -EIO */ });
  },

  // --------------------------------------------------------------------------
  // fd_seek (ASYNC): update a host fd's pos (SEEK_SET/CUR/END). END needs the
  // server size, which fs.open returned (and writes keep current). Default else.
  // (There is no __syscall_lseek in this emcc; lseek funnels through WASI fd_seek.)
  // --------------------------------------------------------------------------
  fd_seek__deps: ['$HostFS', '$FS', '$SYSCALLS'],
  fd_seek__i53abi: true,
  fd_seek__async: true,
  fd_seek: function (fd, offset, whence, newOffset) {
    if (!HostFS.isHostFd(fd)) {
      // SYNC fast path: replicate the default fd_seek (errno -> +errno).
      return HostFS.guardWasi(function () {
        if (isNaN(offset)) { return 61 /* EOVERFLOW */; }
        var stream = SYSCALLS.getStreamFromFD(fd);
        FS.llseek(stream, offset, whence);
        HEAP32[newOffset >> 2] = stream.position;
        HEAP32[(newOffset + 4) >> 2] = 0;
        if (stream.getdents && offset === 0 && whence === 0) { stream.getdents = null; }
        return 0;
      });
    }
    var h = HostFS.open[fd];
    var SEEK_SET = 0, SEEK_CUR = 1, SEEK_END = 2;
    var base;
    if (whence === SEEK_SET) { base = 0; }
    else if (whence === SEEK_CUR) { base = h.pos; }
    else if (whence === SEEK_END) { base = h.size; }
    else { return 28 /* EINVAL */; }
    h.pos = base + offset;
    if (h.pos < 0) { h.pos = 0; }
    // newOffset is an i64; write low/high (positions fit in 32 bits here).
    HEAP32[newOffset >> 2] = h.pos & 0xffffffff;
    HEAP32[(newOffset + 4) >> 2] = Math.floor(h.pos / 0x100000000);
    if (offset === 0 && whence === SEEK_SET) { h.dents = null; h.dentsPos = 0; }
    return 0;
  },

  // --------------------------------------------------------------------------
  // __syscall_fstat64 (ASYNC): host fds round-trip server fs.stat; else default.
  // musl fstat(fd) hits __syscall_fstat64 FIRST (then __syscall_newfstatat).
  // --------------------------------------------------------------------------
  __syscall_fstat64__deps: ['$HostFS', '$FS', '$SYSCALLS'],
  __syscall_fstat64__async: true,
  __syscall_fstat64: function (fd, buf) {
    if (!HostFS.isHostFd(fd)) {
      return HostFS.guard(function () {
        var stream = SYSCALLS.getStreamFromFD(fd);
        return SYSCALLS.doStat(FS.stat, stream.path, buf);
      });
    }
    var h = HostFS.open[fd];
    return HostFS.proxy().request('fs.stat', { path: h.rel }).then(function (resp) {
      var r = resp.result || {};
      if (!r.exists) { return -44; /* -ENOENT */ }
      return HostFS.doHostStat(r, fd, buf);
    }, function () { return -44; });
  },

  // --------------------------------------------------------------------------
  // __syscall_newfstatat (ASYNC): mount-prefix paths round-trip fs.stat/fs.lstat;
  // a host dirfd + empty path (AT_EMPTY_PATH) round-trips fs.stat; else default.
  // nvim stats constantly, so the mode/size must be right.
  // --------------------------------------------------------------------------
  __syscall_newfstatat__deps: ['$HostFS', '$FS', '$SYSCALLS'],
  __syscall_newfstatat__async: true,
  __syscall_newfstatat: function (dirfd, path, buf, flags) {
    var p = SYSCALLS.getStr(path);
    var AT_SYMLINK_NOFOLLOW = 256, AT_EMPTY_PATH = 0x1000;
    var nofollow = flags & AT_SYMLINK_NOFOLLOW;
    var allowEmpty = flags & AT_EMPTY_PATH;

    // Host dirfd with an empty path: stat the fd's own host path.
    if (HostFS.isHostFd(dirfd) && p === '' && allowEmpty) {
      var hh = HostFS.open[dirfd];
      return HostFS.proxy().request('fs.stat', { path: hh.rel }).then(function (resp) {
        var r = resp.result || {};
        if (!r.exists) { return -44; }
        return HostFS.doHostStat(r, dirfd, buf);
      }, function () { return -44; });
    }

    var full;
    try { full = SYSCALLS.calculateAt(dirfd, p, allowEmpty); }
    catch (e) {
      // Default behavior reproduces this throw via doStat's FS call; fall through.
      full = p;
    }

    if (!HostFS.isHostPath(full)) {
      // SYNC fast path: the default newfstatat (clear the handled flags first).
      var rest = flags & (~(AT_SYMLINK_NOFOLLOW | AT_EMPTY_PATH | 0x800 /*AT_NO_AUTOMOUNT*/));
      var fullDef;
      try { fullDef = SYSCALLS.calculateAt(dirfd, p, allowEmpty); }
      catch (e2) { return -(e2 && e2.errno ? e2.errno : 44); }
      try { return SYSCALLS.doStat(nofollow ? FS.lstat : FS.stat, fullDef, buf); }
      catch (e3) { return -(e3 && e3.errno ? e3.errno : 44); }
    }

    var rel = HostFS.rel(full);
    var method = nofollow ? 'fs.lstat' : 'fs.stat';
    return HostFS.proxy().request(method, { path: rel }).then(function (resp) {
      var r = resp.result || {};
      if (!r.exists) { return -44; }
      // Stable-ish inode from the path so equal paths get equal inos.
      var ino = 0;
      for (var i = 0; i < rel.length; i++) { ino = ((ino * 31) + rel.charCodeAt(i)) >>> 0; }
      return HostFS.doHostStat(r, ino || 1, buf);
    }, function () { return -44; });
  },

  // --------------------------------------------------------------------------
  // __syscall_stat64 / __syscall_lstat64 (ASYNC): the PATH-based stat seam.
  // CRITICAL: musl's stat()/lstat() route here, NOT through __syscall_newfstatat
  // -- and libuv's uv_fs_stat() (which backs isdirectory()/getftype()/glob()'s
  // existence check / vim.uv.fs_stat) calls stat(path). Without these overrides a
  // /host path stats against MEMFS (where it doesn't exist), so isdirectory()
  // returns 0 and glob() expands to nothing even though getdents/readdir work.
  // (The fd-based fstat -> __syscall_fstat64; the *at form -> newfstatat; the
  // plain path form lands HERE. All three seams must be covered.)
  // --------------------------------------------------------------------------
  __syscall_stat64__deps: ['$HostFS', '$FS', '$SYSCALLS'],
  __syscall_stat64__async: true,
  __syscall_stat64: function (path, buf) {
    var p = SYSCALLS.getStr(path);
    if (!HostFS.isHostPath(p)) {
      return HostFS.guard(function () { return SYSCALLS.doStat(FS.stat, p, buf); });
    }
    return HostFS.statHostPath('fs.stat', HostFS.rel(p), buf);
  },

  __syscall_lstat64__deps: ['$HostFS', '$FS', '$SYSCALLS'],
  __syscall_lstat64__async: true,
  __syscall_lstat64: function (path, buf) {
    var p = SYSCALLS.getStr(path);
    if (!HostFS.isHostPath(p)) {
      return HostFS.guard(function () { return SYSCALLS.doStat(FS.lstat, p, buf); });
    }
    return HostFS.statHostPath('fs.lstat', HostFS.rel(p), buf);
  },

  // --------------------------------------------------------------------------
  // close: host fds tell the server to close + drop the side map; else default.
  // CLOSE SEAM: in this emcc close(2) funnels through WASI fd_close (NOT
  // __syscall_close) -- the same kind of seam surprise as fd_read. We override
  // BOTH so any caller is covered. The server close is fire-and-forget (nothing
  // waits on it), so close stays SYNC and never suspends on a MEMFS close.
  $closeHostFd__deps: ['$HostFS'],
  $closeHostFd: function (fd) {
    var h = HostFS.open[fd];
    delete HostFS.open[fd];
    try {
      if (h && h.handle != null) {
        var pr = HostFS.proxy().request('fs.close', { handle: h.handle });
        if (pr && typeof pr.catch === 'function') { pr.catch(function () {}); }
      }
    } catch (e) { /* ignore: best-effort close */ }
    return 0;
  },

  fd_close__deps: ['$HostFS', '$FS', '$SYSCALLS', '$closeHostFd'],
  fd_close: function (fd) {
    if (HostFS.isHostFd(fd)) { return closeHostFd(fd); }
    return HostFS.guardWasi(function () {
      var stream = SYSCALLS.getStreamFromFD(fd);
      FS.close(stream);
      return 0;
    });
  },

  __syscall_close__deps: ['$HostFS', '$FS', '$SYSCALLS', '$closeHostFd'],
  __syscall_close: function (fd) {
    if (HostFS.isHostFd(fd)) { return closeHostFd(fd); }
    return HostFS.guard(function () {
      var stream = SYSCALLS.getStreamFromFD(fd);
      FS.close(stream);
      return 0;
    });
  },

  // --------------------------------------------------------------------------
  // fd_sync (WASI): host fds are written through to the server immediately, so a
  // sync is a no-op; else delegate to the default (which under ASYNCIFY does a
  // syncfs). nvim fsyncs after writing a buffer -- without this it would EBADF.
  // --------------------------------------------------------------------------
  fd_sync__deps: ['$HostFS', '$FS', '$SYSCALLS'],
  fd_sync__async: true,
  fd_sync: function (fd) {
    if (HostFS.isHostFd(fd)) { return 0; }   // already durable on the server
    // Default fd_sync (mirrors the emcc impl's syncfs handling under ASYNCIFY).
    return HostFS.guardWasi(function () {
      var stream = SYSCALLS.getStreamFromFD(fd);
      var mount = stream.node.mount;
      if (!mount.type.syncfs) { return 0; } // MEMFS: nothing to flush
      return new Promise(function (resolve) {
        mount.type.syncfs(mount, false, function () { resolve(0); });
      });
    });
  },

  // --------------------------------------------------------------------------
  // __syscall_ftruncate64: host fds round-trip... actually nvim truncates a fresh
  // file via O_TRUNC at open, so a separate ftruncate on a host fd is rare. We
  // accept it as a no-op for host fds (the write path already replaces contents);
  // else default. (A precise host ftruncate would need an fs.truncate handler;
  // the write+open(O_TRUNC) path nvim uses doesn't need it -- see the report.)
  // --------------------------------------------------------------------------
  __syscall_ftruncate64__deps: ['$HostFS', '$FS', '$SYSCALLS'],
  __syscall_ftruncate64__i53abi: true,
  __syscall_ftruncate64: function (fd, length) {
    if (HostFS.isHostFd(fd)) {
      var h = HostFS.open[fd];
      if (h && length < h.size) { h.size = length; }
      return 0;
    }
    return HostFS.guard(function () { FS.ftruncate(fd, length); return 0; });
  },

  // --------------------------------------------------------------------------
  // __syscall_getdents64 (ASYNC): a host fd that is a directory round-trips
  // server fs.readdir and synthesizes fixed-size dirent records (the same layout
  // the default emits: size 280, d_ino@0 i64, d_off@8 i64, d_reclen@16 i16,
  // d_type@18 i8, d_name@19). Supports the multi-call drain (returns 0 when
  // exhausted). Powers `:e <dir>`. Else default.
  // --------------------------------------------------------------------------
  __syscall_getdents64__deps: ['$HostFS', '$FS', '$SYSCALLS', '$stringToUTF8'],
  __syscall_getdents64__async: true,
  __syscall_getdents64: function (fd, dirp, count) {
    if (!HostFS.isHostFd(fd)) {
      // SYNC fast path: replicate the default getdents64 exactly (errno -> -errno).
      return HostFS.guard(function () { return defaultGetdents(fd, dirp, count); });
    }

    function defaultGetdents(fd, dirp, count) {
      var stream = SYSCALLS.getStreamFromFD(fd);
      stream.getdents || (stream.getdents = FS.readdir(stream.path));
      var SS = 280;
      var pos0 = 0;
      var off = FS.llseek(stream, 0, 1 /*SEEK_CUR*/);
      var idx = Math.floor(off / SS);
      while (idx < stream.getdents.length && pos0 + SS <= count) {
        var id, type, name = stream.getdents[idx];
        if (name === '.') { id = stream.node.id; type = 4; }
        else if (name === '..') {
          var lk = FS.lookupPath(stream.path, { parent: true });
          id = lk.node.id; type = 4;
        } else {
          var child = FS.lookupNode(stream.node, name);
          id = child.id;
          type = FS.isChrdev(child.mode) ? 2 : FS.isDir(child.mode) ? 4 :
                 FS.isLink(child.mode) ? 10 : 8;
        }
        HEAP32[(dirp + pos0) >> 2] = id & 0xffffffff;
        HEAP32[(dirp + pos0 + 4) >> 2] = Math.floor(id / 0x100000000);
        HEAP32[(dirp + pos0 + 8) >> 2] = ((idx + 1) * SS) & 0xffffffff;
        HEAP32[(dirp + pos0 + 12) >> 2] = 0;
        HEAP16[(dirp + pos0 + 16) >> 1] = SS;
        HEAP8[dirp + pos0 + 18] = type;
        stringToUTF8(name, dirp + pos0 + 19, 256);
        pos0 += SS;
        idx += 1;
      }
      FS.llseek(stream, idx * SS, 0 /*SEEK_SET*/);
      return pos0;
    }

    // ASYNC host directory drain.
    var h = HostFS.open[fd];
    var SSIZE = 280;

    function emit() {
      // h.dents is the synthesized record list: [{name, isDir}, ...] including
      // "." and "..". Drain from h.dentsPos (a RECORD index) into dirp.
      var recs = h.dents;
      var written = 0;
      while (h.dentsPos < recs.length && written + SSIZE <= count) {
        var e = recs[h.dentsPos];
        var ino = (h.dentsPos + 1); // arbitrary but nonzero + unique per record
        var type = e.isDir ? 4 /*DT_DIR*/ : 8 /*DT_REG*/;
        var base = dirp + written;
        HEAP32[base >> 2] = ino & 0xffffffff;
        HEAP32[(base + 4) >> 2] = 0;
        // d_off: the byte offset of the NEXT record (record-index based here).
        HEAP32[(base + 8) >> 2] = ((h.dentsPos + 1) * SSIZE) & 0xffffffff;
        HEAP32[(base + 12) >> 2] = 0;
        HEAP16[(base + 16) >> 1] = SSIZE;
        HEAP8[base + 18] = type;
        stringToUTF8(e.name, base + 19, 256);
        written += SSIZE;
        h.dentsPos += 1;
      }
      return written;
    }

    if (h.dents) {
      // Already fetched: continue draining (no round-trip).
      return Promise.resolve(emit());
    }
    return HostFS.proxy().request('fs.readdir', { path: h.rel }).then(function (resp) {
      var entries = (resp.result && resp.result.entries) || [];
      // Prepend "." and ".." so nvim's directory browser sees them (the default
      // getdents includes them; netrw and globbing tolerate either, but match).
      h.dents = [{ name: '.', isDir: true }, { name: '..', isDir: true }];
      for (var i = 0; i < entries.length; i++) {
        h.dents.push({ name: entries[i].name, isDir: !!entries[i].isDir });
      }
      h.dentsPos = 0;
      return emit();
    }, function () { return -29; /* -EIO */ });
  },

  // --------------------------------------------------------------------------
  // __syscall_mkdirat (ASYNC): mount-prefix paths route to server fs.mkdir; else
  // default. nvim's write path may mkdir backup/undo dirs.
  // --------------------------------------------------------------------------
  __syscall_mkdirat__deps: ['$HostFS', '$FS', '$SYSCALLS', '$PATH'],
  __syscall_mkdirat__async: true,
  __syscall_mkdirat: function (dirfd, path, mode) {
    var p = SYSCALLS.getStr(path);
    var full;
    try { full = SYSCALLS.calculateAt(dirfd, p); }
    catch (e) { full = p; }
    if (!HostFS.isHostPath(full)) {
      // SYNC fast path: the default mkdirat.
      var np = PATH.normalize(full);
      if (np[np.length - 1] === '/') { np = np.substr(0, np.length - 1); }
      try { FS.mkdir(np, mode, 0); return 0; }
      catch (e2) { return -(e2 && e2.errno ? e2.errno : 20 /*EEXIST*/); }
    }
    var rel = HostFS.rel(full);
    return HostFS.proxy().request('fs.mkdir', { path: rel, mode: mode }).then(function () {
      return 0;
    }, function (e) { return -(e && e.errno ? e.errno : 20); });
  },

  // --------------------------------------------------------------------------
  // __syscall_unlinkat (ASYNC): mount-prefix paths route to server fs.unlink
  // (dir:true for rmdir); else default. nvim's backup/swap cleanup unlinks.
  // --------------------------------------------------------------------------
  __syscall_unlinkat__deps: ['$HostFS', '$FS', '$SYSCALLS'],
  __syscall_unlinkat__async: true,
  __syscall_unlinkat: function (dirfd, path, flags) {
    var p = SYSCALLS.getStr(path);
    var full;
    try { full = SYSCALLS.calculateAt(dirfd, p); }
    catch (e) { full = p; }
    var AT_REMOVEDIR = 0x200;
    if (!HostFS.isHostPath(full)) {
      // SYNC fast path: the default unlinkat.
      try {
        if (flags === 0) { FS.unlink(full); }
        else if (flags === AT_REMOVEDIR) { FS.rmdir(full); }
        else { return -28 /*EINVAL*/; }
        return 0;
      } catch (e2) { return -(e2 && e2.errno ? e2.errno : 44); }
    }
    var rel = HostFS.rel(full);
    return HostFS.proxy().request('fs.unlink', { path: rel, dir: flags === AT_REMOVEDIR })
      .then(function () { return 0; },
            function (e) { return -(e && e.errno ? e.errno : 44); });
  },

  // --------------------------------------------------------------------------
  // __syscall_renameat (ASYNC): if EITHER side is a mount-prefix path, route to
  // server fs.rename; else default. nvim's write path renames a temp/backup into
  // place (and `:saveas`/`:w` use rename). Cross-boundary renames (host<->memfs)
  // are rejected with EXDEV -- the server can't see MEMFS and vice versa.
  // --------------------------------------------------------------------------
  __syscall_renameat__deps: ['$HostFS', '$FS', '$SYSCALLS'],
  __syscall_renameat__async: true,
  __syscall_renameat: function (olddirfd, oldpath, newdirfd, newpath) {
    var op = SYSCALLS.getStr(oldpath), npth = SYSCALLS.getStr(newpath);
    var oldFull, newFull;
    try { oldFull = SYSCALLS.calculateAt(olddirfd, op); } catch (e) { oldFull = op; }
    try { newFull = SYSCALLS.calculateAt(newdirfd, npth); } catch (e) { newFull = npth; }
    var oldHost = HostFS.isHostPath(oldFull), newHost = HostFS.isHostPath(newFull);
    if (!oldHost && !newHost) {
      // SYNC fast path: the default renameat.
      try { FS.rename(oldFull, newFull); return 0; }
      catch (e2) { return -(e2 && e2.errno ? e2.errno : 44); }
    }
    if (oldHost !== newHost) {
      return -75; // -EXDEV: cannot rename across the host/MEMFS boundary.
    }
    return HostFS.proxy().request('fs.rename',
      { from: HostFS.rel(oldFull), to: HostFS.rel(newFull) })
      .then(function () { return 0; },
            function (e) { return -(e && e.errno ? e.errno : 44); });
  },

  // --------------------------------------------------------------------------
  // __syscall_faccessat (ASYNC): mount-prefix paths round-trip fs.stat and answer
  // the access() check from existence + the mode bits; else default. This is
  // LOAD-BEARING for `:w`: nvim calls os_file_is_writable() -> access(W_OK) when
  // loading a buffer, and on the default impl a host path isn't in MEMFS, so the
  // check fails and nvim marks the buffer 'readonly' -> `:w` then errors E45.
  // --------------------------------------------------------------------------
  __syscall_faccessat__deps: ['$HostFS', '$FS', '$SYSCALLS'],
  __syscall_faccessat__async: true,
  __syscall_faccessat: function (dirfd, path, amode, flags) {
    var p = SYSCALLS.getStr(path);
    var full;
    try { full = SYSCALLS.calculateAt(dirfd, p); }
    catch (e) { full = p; }

    if (!HostFS.isHostPath(full)) {
      // SYNC fast path: the default faccessat (errno -> -errno via guard).
      return HostFS.guard(function () {
        if (amode & ~7 /* ~S_IRWXO */) { return -28 /*EINVAL*/; }
        var lookup = FS.lookupPath(full, { follow: true });
        var node = lookup.node;
        if (!node) { return -44 /*ENOENT*/; }
        var perms = '';
        if (amode & 4) { perms += 'r'; }
        if (amode & 2) { perms += 'w'; }
        if (amode & 1) { perms += 'x'; }
        if (perms && FS.nodePermissions(node, perms)) { return -2 /*EACCES*/; }
        return 0;
      });
    }

    var rel = HostFS.rel(full);
    return HostFS.proxy().request('fs.stat', { path: rel }).then(function (resp) {
      var r = resp.result || {};
      if (!r.exists) { return -44; /* -ENOENT (F_OK fails) */ }
      // R_OK/W_OK/X_OK: answer from the mode's owner bits (the server runs as the
      // user who owns the jail). W_OK is the one nvim's writability probe needs.
      var mode = (typeof r.mode === 'number') ? r.mode : (r.isDir ? 0x41ed : 0x81a4);
      if ((amode & 4) && !(mode & 0x100 /*S_IRUSR*/)) { return -2; }
      if ((amode & 2) && !(mode & 0x80  /*S_IWUSR*/)) { return -2; }
      if ((amode & 1) && !(mode & 0x40  /*S_IXUSR*/)) { return -2; }
      return 0;
    }, function () { return -44; });
  },

  // --------------------------------------------------------------------------
  // __syscall_utimensat (ASYNC): mount-prefix paths are a no-op (the server
  // already stamps mtime on write; nvim calls this to preserve times across its
  // backup dance and an error would surface). Else default. We accept + ignore
  // for host paths rather than route a server call -- times are best-effort.
  // --------------------------------------------------------------------------
  __syscall_utimensat__deps: ['$HostFS', '$FS', '$SYSCALLS', '$readI53FromI64'],
  __syscall_utimensat__async: true,
  __syscall_utimensat: function (dirfd, path, times, flags) {
    var p = SYSCALLS.getStr(path);
    var full;
    try { full = SYSCALLS.calculateAt(dirfd, p, true); }
    catch (e) { full = p; }
    if (HostFS.isHostPath(full)) {
      return 0; // accept + ignore: server stamps mtime on write (best-effort).
    }
    // SYNC fast path: the default utimensat (errno -> -errno via guard).
    return HostFS.guard(function () {
      var now = Date.now(), atime, mtime;
      if (!times) { atime = now; mtime = now; }
      else {
        var aSec = readI53FromI64(times);
        var aNsec = HEAP32[(times + 8) >> 2];
        var mSec = readI53FromI64(times + 16);
        var mNsec = HEAP32[(times + 16 + 8) >> 2];
        var UTIME_NOW = 0x3fffffff, UTIME_OMIT = 0x3ffffffe;
        atime = (aNsec === UTIME_NOW) ? now : (aNsec === UTIME_OMIT ? null : aSec * 1000 + aNsec / 1000000);
        mtime = (mNsec === UTIME_NOW) ? now : (mNsec === UTIME_OMIT ? null : mSec * 1000 + mNsec / 1000000);
      }
      if (atime !== null || mtime !== null) {
        FS.utime(full, atime === null ? mtime : atime, mtime === null ? atime : mtime);
      }
      return 0;
    });
  },
});
