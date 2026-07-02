// wasm/nvim_proc_proxy.js - Emscripten JS-library: the IO-proxy process-spawn
// backend's JS half (Stage 4, Phase 3 -- seam 2). Pairs with
// src/nvim/event/proxy_proc.c.
//
// ============================================================================
// WHAT THIS DOES
// ============================================================================
// When the engine worker is configured with an IO-proxy (globalThis.__nvimProxy),
// non-PTY child processes (:!cmd, system(), jobstart(), and -- for free -- LSP
// stdio servers) run on the SERVER, with their stdin/stdout/stderr carried over
// VIRTUAL pollable fds wired into nvim's existing rstream/wstream layer.
//
// This productionizes de-risking SPIKE B: a MEMFS-backed fd with queue-backed
// read/write/poll stream_ops + a truthy `stream.tty` marker is accepted by
// uv_pipe_open(fd) (the C side does the uv_pipe_open), and the async
// __syscall_poll in wasm/nvim_io.js delivers async-pushed bytes to nvim's read
// callback. (The same `applyChannelOps` shape that backs the engine's own fd 0/1.)
//
// ============================================================================
// HARD INVARIANT (binding): ADDITIVE + OPT-IN
// ============================================================================
// With NO proxy configured, nvim_proxy_active() returns 0, so proc.c never
// retargets a uv proc to the proxy backend -- spawning fails exactly as today and
// none of this code runs.
//
// ============================================================================
// THE SYNC-SPAWN / ASYNC-SERVER SEAM
// ============================================================================
// C's proxy_proc_spawn() is SYNCHRONOUS (not __async) -- it must return a child
// id immediately. The server round-trip is async, so nvim_proxy_proc_spawn()
// allocates a LOCAL child id synchronously, fires `proc.spawn` in the background,
// and returns the local id at once. The server's reply carries the server's child
// id, which we map to the local entry so subsequent stdout/stderr/exit pushes
// route correctly. A spawn FAILURE (bad command, server error) is delivered back
// through the normal exit path by calling the C exit entry with status 127 -- so
// nvim sees a clean "command exited 127", never a hang.
//
// ============================================================================
// SERVER PROTOCOL (handled by the rvim Go server: wasm/rvim/server/proc.go)
// ============================================================================
//   proc.spawn       {argv:[...], cwd, env:{...}, wantIn, wantOut, wantErr}
//                       -> {id}            (server child id)
//   proc.stdin       {id} + payload<bytes> -> {ok}      (write child stdin)
//   proc.stdin_close {id}                  -> {ok}      (close child stdin / EOF)
//   proc.kill        {id, signal}          -> {ok}
//   server pushes:
//     proc.stdout {id} + payload<bytes>    (child stdout chunk)
//     proc.stderr {id} + payload<bytes>    (child stderr chunk)
//     proc.exit   {id, code, signal}       (child exited)
// ============================================================================

addToLibrary({
  // --------------------------------------------------------------------------
  // $ProcProxy: shared state + helpers. Read the proxy lazily off globalThis so
  // the library links cleanly with or without one.
  // --------------------------------------------------------------------------
  $ProcProxy__deps: ['$FS', '$NvimIO', '$PATH_FS'],
  $ProcProxy: {
    nextLocalId: 1,          // local child ids handed to C (used as proc->pid)
    nextFd: 200000,          // virtual stdio fds, above the fs-proxy host range
    fds: {},                 // fd -> { ch, mode }   (the pollable channel)
    byHandle: {},            // handle(ptr) -> child entry
    byServerId: {},          // server child id -> child entry
    pushWired: false,        // have we installed the onPush router yet?

    dbg: function (m) {
      try {
        if (typeof process !== 'undefined' && process.env && process.env.NVIM_PROC_PROXY_LOG) {
          if (typeof err === 'function') { err('[proc-proxy] ' + m); }
        }
      } catch (e) { /* ignore */ }
    },

    proxy: function () {
      return (typeof globalThis !== 'undefined' && globalThis.__nvimProxy) || null;
    },

    // Read + normalize a spawn cwd: a RELATIVE cwd (nvim's :terminal passes "."
    // via the term:// URI) is resolved against the ENGINE's cwd -- which IS a
    // server path (the server's filesystem is mounted at the engine's root) --
    // so the server always receives an absolute path. Empty stays empty (the
    // server falls back to its own working dir).
    readCwd: function (cwdPtr) {
      var cwd = cwdPtr ? UTF8ToString(cwdPtr) : '';
      if (cwd && cwd[0] !== '/') {
        try { cwd = PATH_FS.resolve(cwd); } catch (e) { cwd = ''; }
      }
      return cwd;
    },

    // Wake the JSPI-suspended __syscall_poll (the NvimIO.wake set during a wait).
    // nvim's poll() lives in wasm/nvim_io.js; its signalWake resumes it.
    wake: function () { NvimIO.signalWake(); },

    // Install message-channel-style pollable stream ops on an FS stream, à la
    // wasm/nvim_io.js applyChannelOps + SPIKE B. mode 'r' (child stdout/stderr,
    // readable by nvim) drains ch.inQueue; mode 'w' (child stdin, written by
    // nvim) hands bytes to the server via `proc.stdin`. `ch.onWrite(bytes)` /
    // `ch.onClose()` are installed by the spawn wiring.
    applyOps: function (stream, ch, mode) {
      var EAGAIN = 6, ESPIPE = 70;
      var POLLIN = 0x001, POLLOUT = 0x004;
      stream.seekable = false;
      // Keep it a "tty" so isatty(fd) -> uv_guess_handle() returns UV_TTY (the
      // pipe path), not UV_FILE (which libuv would read as a file and EOF).
      stream.tty = { ops: {} };
      stream.stream_ops = {
        read: function (stream, buffer, offset, length) {
          var q = ch.inQueue;
          if (!q || q.length === 0) {
            if (ch.closed) { return 0; }   // genuine EOF (child stream ended)
            throw new FS.ErrnoError(EAGAIN);
          }
          var u8 = new Uint8Array(buffer.buffer, buffer.byteOffset || 0);
          var n = 0;
          while (n < length && q.length > 0) {
            var head = q[0];
            var avail = head.buf.length - head.off;
            var take = Math.min(avail, length - n);
            u8.set(head.buf.subarray(head.off, head.off + take), offset + n);
            head.off += take;
            n += take;
            if (head.off >= head.buf.length) { q.shift(); }
          }
          return n;
        },
        write: function (stream, buffer, offset, length) {
          // Copy out of the wasm heap (memory growth can detach it; the bytes
          // ride a proxy frame asynchronously).
          var u8 = new Uint8Array(buffer.buffer, (buffer.byteOffset || 0) + offset, length);
          if (ch.onWrite) { ch.onWrite(u8.slice()); }
          return length;
        },
        poll: function (stream, timeout) {
          var mask = 0;
          if (mode === 'r' && ((ch.inQueue && ch.inQueue.length > 0) || ch.closed)) {
            mask |= POLLIN;
          }
          if (mode === 'w') {
            // The child's stdin is unbounded from nvim's side (the server buffers
            // / backpressures); always writable.
            mask |= POLLOUT;
          }
          return mask;
        },
        // nvim closing the stdin pipe (uv_close -> fd close -> FS.close) lands
        // here: propagate EOF to the child's stdin on the server so a `cat`-style
        // child sees end-of-input and flushes/exits.
        close: function (stream) {
          ch.closed = true;
          if (ch.onClose) { ch.onClose(); }
        },
        llseek: function () { throw new FS.ErrnoError(ESPIPE); },
      };
    },

    // Allocate a virtual pollable fd. Opens a real MEMFS file to get a
    // first-class FS stream (so fcntl works for uv_pipe_open), O_RDWR so libuv
    // marks the handle readable+writable, then swaps in the pollable ops.
    //
    // mode 0 = readable (child stdout/stderr); 1 = writable (child stdin);
    // 2 = PTY (bidirectional): one channel; the fd's stream reads server output
    // (mode 'r'), and ptyDupFd() opens a SECOND stream that writes input ('w')
    // onto the SAME channel -- mirroring the native pty, where one master fd is
    // dup()'d into proc->in (write) and proc->out (read). (Phase 5.)
    allocFd: function (mode) {
      var modeStr = mode === 1 ? 'w' : 'r';  // pty (2) reads via its primary fd
      var name = '/.nvim-proc-proxy-fd-' + ProcProxy.nextFd;
      try {
        FS.writeFile(name, new Uint8Array(0));
        var stream = FS.open(name, 2 /* O_RDWR */);
        var ch = { inQueue: [], closed: false, onWrite: null, onClose: null };
        ProcProxy.applyOps(stream, ch, modeStr);
        ProcProxy.fds[stream.fd] = { ch: ch, mode: modeStr, path: name, pty: (mode === 2) };
        ProcProxy.nextFd++;
        return stream.fd;
      } catch (e) {
        ProcProxy.dbg('allocFd failed: ' + (e && e.message || e));
        return -1;
      }
    },

    // Phase 5: open a SECOND virtual fd ('w' ops) onto the SAME channel as an
    // existing pty fd, so nvim can dup the one pty "master" into both proc->out
    // (the readable primary fd) and proc->in (this writable dup). Writes to this
    // fd become terminal INPUT (-> ch.onWrite -> pty.write). Returns the new fd or
    // -1. The two fds share `ch`, so a server pty.data push (queued on the primary
    // fd's ch.inQueue) is read via the primary fd, and terminal input written to
    // this dup reaches the same server pty.
    ptyDupFd: function (fd) {
      var primary = ProcProxy.fds[fd];
      if (!primary) { return -1; }
      var name = '/.nvim-proc-proxy-fd-' + ProcProxy.nextFd;
      try {
        FS.writeFile(name, new Uint8Array(0));
        var stream = FS.open(name, 2 /* O_RDWR */);
        ProcProxy.applyOps(stream, primary.ch, 'w');  // shares the SAME channel
        ProcProxy.fds[stream.fd] = { ch: primary.ch, mode: 'w', path: name, pty: true, dupOf: fd };
        ProcProxy.nextFd++;
        return stream.fd;
      } catch (e) {
        ProcProxy.dbg('ptyDupFd failed: ' + (e && e.message || e));
        return -1;
      }
    },

    // Enqueue bytes onto a readable fd's channel + wake poll (server stdout/err).
    pushBytes: function (fd, bytes) {
      var slot = ProcProxy.fds[fd];
      if (!slot) { return; }
      slot.ch.inQueue.push({ buf: bytes, off: 0 });
      ProcProxy.wake();
    },

    // Mark a readable fd's channel closed (EOF) + wake poll.
    closeFd: function (fd) {
      var slot = ProcProxy.fds[fd];
      if (!slot) { return; }
      slot.ch.closed = true;
      ProcProxy.wake();
    },

    // Free the MEMFS backing of a virtual fd. The uv handle wrapping it was (or
    // will be) uv_close()'d by nvim's stream teardown; here we just drop our
    // side-table entry + the scratch file. Best-effort.
    //
    // OWNERSHIP GUARD (fixes a fd-number-reuse race): emscripten's FS.open reuses
    // the LOWEST free fd number, so once child A's stdio fd is FS.close()'d, child
    // B's allocFd can be handed the SAME fd NUMBER. The exit-driven release of
    // child A is deferred (a macrotask), so without this guard A's late
    // freeFd(n)/delete fds[n] would clobber B's freshly-installed slot for the
    // reused number n -- B's stdin onWrite/onClose would vanish, EOF would never
    // reach the server, and a `cat` child would hang forever. So we only free a
    // slot when its `owner` still matches the caller's expected owner token.
    freeFd: function (fd, owner) {
      var slot = ProcProxy.fds[fd];
      if (!slot) { return; }
      if (owner != null && slot.owner !== owner) { return; }  // reused by another child
      delete ProcProxy.fds[fd];
      try { FS.unlink(slot.path); } catch (e) { /* ignore */ }
    },

    // Drop all JS-side bookkeeping for a child entry: the byHandle/byServerId
    // maps and the three virtual fds (each freeFd unlinks its scratch MEMFS file;
    // an already-open stream survives the unlink, POSIX-style, until uv_close).
    // Idempotent. Shared by the Phase 3 release (called from C) and the Phase 4
    // deferred release (called from the exit push, since uv-spawn has no C hook).
    releaseEntry: function (entry) {
      if (!entry) { return; }
      if (entry.handle != null) { delete ProcProxy.byHandle[entry.handle]; }
      if (entry.serverId != null) { delete ProcProxy.byServerId[entry.serverId]; }
      // Pass this entry's owner token so a fd NUMBER that was already reused by a
      // newer child is NOT freed out from under it (see freeFd's OWNERSHIP GUARD).
      if (entry.fdIn >= 0) { ProcProxy.freeFd(entry.fdIn, entry.localId); }
      if (entry.fdOut >= 0) { ProcProxy.freeFd(entry.fdOut, entry.localId); }
      if (entry.fdErr >= 0) { ProcProxy.freeFd(entry.fdErr, entry.localId); }
    },

    // Route a server push (proc.stdout/proc.stderr/proc.exit) to the right child.
    // Installed once, lazily, on the shared proxy client.
    wirePush: function () {
      if (ProcProxy.pushWired) { return; }
      var px = ProcProxy.proxy();
      if (!px || typeof px.onPush !== 'function') { return; }
      ProcProxy.pushWired = true;

      // IMPORTANT: compose with any existing push handler (the fs-proxy doesn't
      // use pushes today; the sock proxy DOES -- both must coexist). We chain to
      // whatever handler is currently installed (recorded in px.__nvimPushChain
      // by every proxy that wires one) and record ourselves there so a later
      // wirePush (sock proxy) chains to US. Order-independent.
      var prev = px.__nvimPushChain || null;
      var handler = function (method, params, payload) {
        var id = params && params.id;
        var entry = (id != null) ? ProcProxy.byServerId[id] : null;
        if (method === 'proc.stdout' || method === 'proc.stderr') {
          if (entry) {
            var fd = (method === 'proc.stdout') ? entry.fdOut : entry.fdErr;
            if (fd >= 0 && payload && payload.length) {
              ProcProxy.pushBytes(fd, payload.slice ? payload.slice() : new Uint8Array(payload));
            }
          }
          return;
        }
        if (method === 'proc.stdout_close' || method === 'proc.stderr_close') {
          if (entry) {
            var cfd = (method === 'proc.stdout_close') ? entry.fdOut : entry.fdErr;
            if (cfd >= 0) { ProcProxy.closeFd(cfd); }
          }
          return;
        }
        if (method === 'proc.exit') {
          if (entry && !entry.exited) {
            entry.exited = true;
            // EOF both readable streams so nvim's read_cb sees the end (the
            // server may also have sent explicit *_close; closeFd is idempotent).
            if (entry.fdOut >= 0) { ProcProxy.closeFd(entry.fdOut); }
            if (entry.fdErr >= 0) { ProcProxy.closeFd(entry.fdErr); }
            var code = (params && typeof params.code === 'number') ? params.code : 0;
            var sig = (params && typeof params.signal === 'number') ? params.signal : 0;
            ProcProxy.deliverExit(entry, code, sig);
            // Phase 3 Proc children are released from C (proxy_proc_close). uv-spawn
            // children have NO C close hook (luv uv_close()s the handle directly),
            // so release their JS bookkeeping here. Defer to a macrotask so the
            // synchronous exit_cb -> uv_close -> pipe FS.close (which runs our
            // applyOps.close) has completed before we drop the fds / scratch files.
            if (entry.exitEntry === 'nvim_uv_proxy_on_exit' && !entry.released) {
              entry.released = true;
              var releaseEntry = entry;
              setTimeout(function () { ProcProxy.releaseEntry(releaseEntry); }, 0);
            }
          }
          return;
        }
        // ---- Phase 5: PTY pushes (pty.data / pty.exit) ----------------------
        // A pty entry has a single bidirectional channel: server output arrives
        // as pty.data and is queued on the (readable) primary fd (entry.fdOut),
        // which nvim reads through proc->out. pty.exit drives the same exit flow
        // as a Proc child (the entry's exitEntry is nvim_proxy_proc_on_exit).
        if (method === 'pty.data') {
          if (entry && entry.fdOut >= 0 && payload && payload.length) {
            ProcProxy.pushBytes(entry.fdOut, payload.slice ? payload.slice() : new Uint8Array(payload));
          }
          return;
        }
        if (method === 'pty.exit') {
          if (entry && !entry.exited) {
            entry.exited = true;
            // EOF the readable side so nvim's read_cb sees the end.
            if (entry.fdOut >= 0) { ProcProxy.closeFd(entry.fdOut); }
            var pcode = (params && typeof params.code === 'number') ? params.code : 0;
            var psig = (params && typeof params.signal === 'number') ? params.signal : 0;
            ProcProxy.deliverExit(entry, pcode, psig);
            // A pty proc (kProcTypePty) has NO C close hook that releases JS
            // bookkeeping (proc_close -> pty_proc_close kills + runs close_cb but
            // never calls back into JS), so release here, deferred past the
            // synchronous exit_cb -> uv_close -> FS.close teardown.
            if (!entry.released) {
              entry.released = true;
              var ptyRelease = entry;
              setTimeout(function () { ProcProxy.releaseEntry(ptyRelease); }, 0);
            }
          }
          return;
        }
        if (prev) { try { prev(method, params, payload); } catch (e) { /* ignore */ } }
      };
      px.__nvimPushChain = handler;
      px.onPush(handler);
    },

    // Deliver a child's exit into C by calling the right EMSCRIPTEN_KEEPALIVE
    // entry for that child's spawn path. Two kinds of children share this table:
    //   - Phase 3 nvim-Proc children -> nvim_proxy_proc_on_exit(handle, status,
    //     signal): drives proc->status + on_proc_exit() (close/refcount/proc->cb).
    //   - Phase 4 uv_spawn children (LSP / vim.system / luv) ->
    //     nvim_uv_proxy_on_exit(handle, status, signal): drives uv_spawn's own
    //     exit_cb + the uv_process_t close lifecycle.
    // entry.exitEntry names the C function; default is the Phase 3 Proc entry.
    // We pass the handle pointer as a number (it is a wasm i32 pointer).
    deliverExit: function (entry, code, signal) {
      var fn = entry.exitEntry || 'nvim_proxy_proc_on_exit';
      try {
        // ccall signature: void <fn>(void* handle, int status, int signal).
        // 'number' marshals the pointer + the ints directly.
        Module.ccall(fn, null,
          ['number', 'number', 'number'], [entry.handle, code, signal]);
      } catch (e) {
        ProcProxy.dbg('deliverExit ccall failed (' + fn + '): ' + (e && e.message || e));
      }
    },

    // Shared spawn driver for BOTH the Phase 3 nvim-Proc path and the Phase 4
    // uv_spawn path. C has already allocated + uv_pipe_open'd the virtual stdio
    // fds and handed us their numbers; here we register the child, wire the stdin
    // writer + push routing, fire `proc.spawn` async, and return a local id
    // synchronously. The only per-path difference is `exitEntry` (which C exit
    // function the server's `proc.exit` push must call) -- everything else (fd
    // table, stdin->proc.stdin, stdout/stderr pushes, exit handling) is identical
    // and shared. A spawn FAILURE is delivered through the exit path (status 127)
    // so the caller's job/lifecycle completes cleanly rather than hanging.
    spawnChild: function (handle, argvPtr, cwdPtr, envPtr, fdIn, fdOut, fdErr, exitEntry) {
      var px = ProcProxy.proxy();
      if (!px) { return -1; }

      var argv = ProcProxy.readStrv(argvPtr);
      if (argv.length === 0) { return -1; }
      var cwd = ProcProxy.readCwd(cwdPtr);
      var envList = ProcProxy.readStrv(envPtr);
      var env = null;
      if (envList.length) {
        env = {};
        for (var i = 0; i < envList.length; i++) {
          var eq = envList[i].indexOf('=');
          if (eq > 0) { env[envList[i].slice(0, eq)] = envList[i].slice(eq + 1); }
        }
      }

      var localId = ProcProxy.nextLocalId++;
      var entry = {
        handle: handle, localId: localId, serverId: null,
        fdIn: (fdIn | 0), fdOut: (fdOut | 0), fdErr: (fdErr | 0),
        exited: false, stdinClosed: false,
        exitEntry: exitEntry || 'nvim_proxy_proc_on_exit',
      };
      ProcProxy.byHandle[handle] = entry;

      // Stamp ownership on each adopted fd slot so a deferred release of a PRIOR
      // child that happened to be handed the same (reused) fd number cannot free
      // THIS child's slot. (See freeFd's OWNERSHIP GUARD.)
      var stampOwner = function (fd) {
        if (fd >= 0 && ProcProxy.fds[fd]) { ProcProxy.fds[fd].owner = localId; }
      };
      stampOwner(entry.fdIn);
      stampOwner(entry.fdOut);
      stampOwner(entry.fdErr);

      // Wire the stdin writer: nvim writes to the stdin fd -> proc.stdin request.
      if (entry.fdIn >= 0) {
        var inSlot = ProcProxy.fds[entry.fdIn];
        if (inSlot) {
          inSlot.ch.onWrite = function (bytes) {
            if (entry.serverId == null) {
              (entry.stdinBuf || (entry.stdinBuf = [])).push(bytes);
              return;
            }
            px.request('proc.stdin', { id: entry.serverId }, bytes)
              .catch(function () { /* child gone; reads will EOF */ });
          };
          inSlot.ch.onClose = function () {
            if (entry.serverId != null && !entry.stdinClosed) {
              entry.stdinClosed = true;
              px.request('proc.stdin_close', { id: entry.serverId }).catch(function () {});
            }
          };
        }
      }

      ProcProxy.wirePush();

      px.request('proc.spawn', {
        argv: argv, cwd: cwd, env: env,
        wantIn: entry.fdIn >= 0, wantOut: entry.fdOut >= 0, wantErr: entry.fdErr >= 0,
      }).then(function (resp) {
        var sid = resp && resp.result && resp.result.id;
        if (sid == null) { throw new Error('proc.spawn: no id'); }
        entry.serverId = sid;
        ProcProxy.byServerId[sid] = entry;
        if (entry.killOnAck != null) {
          px.request('proc.kill', { id: sid, signal: entry.killOnAck }).catch(function () {});
          entry.killOnAck = null;
        }
        if (entry.stdinBuf && entry.stdinBuf.length) {
          for (var j = 0; j < entry.stdinBuf.length; j++) {
            px.request('proc.stdin', { id: sid }, entry.stdinBuf[j]).catch(function () {});
          }
          entry.stdinBuf = null;
        }
        if (entry.fdIn >= 0) {
          var slot = ProcProxy.fds[entry.fdIn];
          if (slot && slot.ch.closed && !entry.stdinClosed) {
            entry.stdinClosed = true;
            px.request('proc.stdin_close', { id: sid }).catch(function () {});
          }
        }
      }, function (e) {
        ProcProxy.dbg('proc.spawn failed: ' + (e && e.message || e));
        if (!entry.exited) {
          entry.exited = true;
          if (entry.fdOut >= 0) { ProcProxy.closeFd(entry.fdOut); }
          if (entry.fdErr >= 0) { ProcProxy.closeFd(entry.fdErr); }
          ProcProxy.deliverExit(entry, 127, 0);
        }
      });

      return localId;
    },

    // Phase 5: PTY spawn driver. C has allocated ONE bidirectional virtual fd
    // (fdOut, the readable primary that nvim's proc->out reads) and a write dup
    // (fdIn, nvim's proc->in for terminal input), both sharing one channel, and
    // uv_pipe_open'd them. Here we register the pty entry, wire the input writer
    // (nvim writes the pty input fd -> pty.write), fire `pty.spawn` async with the
    // initial cols/rows, and return a local id synchronously. Exit drives
    // nvim_proxy_proc_on_exit (a pty proc's exit_cb is on_proc_exit, exactly like
    // a Proc child). A spawn FAILURE is delivered through the exit path (127).
    spawnPty: function (handle, argvPtr, cwdPtr, envPtr, fd, fdIn, cols, rows) {
      var px = ProcProxy.proxy();
      if (!px) { return -1; }

      var argv = ProcProxy.readStrv(argvPtr);
      if (argv.length === 0) { return -1; }
      var cwd = ProcProxy.readCwd(cwdPtr);
      var envList = ProcProxy.readStrv(envPtr);
      var env = null;
      if (envList.length) {
        env = {};
        for (var i = 0; i < envList.length; i++) {
          var eq = envList[i].indexOf('=');
          if (eq > 0) { env[envList[i].slice(0, eq)] = envList[i].slice(eq + 1); }
        }
      }

      var localId = ProcProxy.nextLocalId++;
      var entry = {
        handle: handle, localId: localId, serverId: null,
        fdIn: (fdIn | 0), fdOut: (fd | 0), fdErr: -1,
        exited: false, isPty: true,
        exitEntry: 'nvim_proxy_proc_on_exit',
      };
      ProcProxy.byHandle[handle] = entry;

      // Stamp ownership on both shared-channel fds (see freeFd's OWNERSHIP GUARD).
      if (entry.fdOut >= 0 && ProcProxy.fds[entry.fdOut]) { ProcProxy.fds[entry.fdOut].owner = localId; }
      if (entry.fdIn >= 0 && ProcProxy.fds[entry.fdIn]) { ProcProxy.fds[entry.fdIn].owner = localId; }

      // Wire the input writer: nvim writes the pty input fd -> pty.write request.
      // Both fds share one channel, so install onWrite on that shared channel.
      var ch = (entry.fdOut >= 0 && ProcProxy.fds[entry.fdOut]) ? ProcProxy.fds[entry.fdOut].ch : null;
      if (ch) {
        ch.onWrite = function (bytes) {
          if (entry.serverId == null) {
            (entry.inBuf || (entry.inBuf = [])).push(bytes);
            return;
          }
          px.request('pty.write', { id: entry.serverId }, bytes)
            .catch(function () { /* pty gone; reads will EOF */ });
        };
        // A pty has no stdin-EOF concept; closing a stream just drops the channel.
        ch.onClose = function () { /* teardown handled via pty.kill on close */ };
      }

      ProcProxy.wirePush();

      px.request('pty.spawn', {
        argv: argv, cwd: cwd, env: env, cols: (cols | 0), rows: (rows | 0),
      }).then(function (resp) {
        var sid = resp && resp.result && resp.result.id;
        if (sid == null) { throw new Error('pty.spawn: no id'); }
        entry.serverId = sid;
        ProcProxy.byServerId[sid] = entry;
        if (entry.killOnAck != null) {
          px.request('pty.kill', { id: sid, signal: entry.killOnAck }).catch(function () {});
          entry.killOnAck = null;
        }
        if (entry.resizeOnAck) {
          px.request('pty.resize', { id: sid, cols: entry.resizeOnAck.cols, rows: entry.resizeOnAck.rows })
            .catch(function () {});
          entry.resizeOnAck = null;
        }
        if (entry.inBuf && entry.inBuf.length) {
          for (var j = 0; j < entry.inBuf.length; j++) {
            px.request('pty.write', { id: sid }, entry.inBuf[j]).catch(function () {});
          }
          entry.inBuf = null;
        }
      }, function (e) {
        ProcProxy.dbg('pty.spawn failed: ' + (e && e.message || e));
        if (!entry.exited) {
          entry.exited = true;
          if (entry.fdOut >= 0) { ProcProxy.closeFd(entry.fdOut); }
          ProcProxy.deliverExit(entry, 127, 0);
        }
      });

      return localId;
    },

    // Read a NUL-separated, double-NUL-terminated C buffer into a JS string array
    // (stops at the empty trailing string). Mirrors flatten_strv() in C.
    readStrv: function (ptr) {
      var out = [];
      if (!ptr) { return out; }
      var p = ptr;
      while (true) {
        var s = UTF8ToString(p);
        if (s === '') { break; }            // empty string == double-NUL terminator
        out.push(s);
        p += lengthBytesUTF8(s) + 1;        // advance past this string + its NUL
      }
      return out;
    },
  },

  // --------------------------------------------------------------------------
  // nvim_proxy_active(): nonzero iff a proxy is configured. proc.c gates the
  // whole backend on this.
  // --------------------------------------------------------------------------
  nvim_proxy_active__deps: ['$ProcProxy'],
  nvim_proxy_active: function () {
    return ProcProxy.proxy() ? 1 : 0;
  },

  // --------------------------------------------------------------------------
  // nvim_proxy_alloc_fd(mode): allocate a virtual pollable stdio fd. mode 0 =
  // readable (child stdout/stderr), 1 = writable (child stdin).
  // --------------------------------------------------------------------------
  nvim_proxy_alloc_fd__deps: ['$ProcProxy'],
  nvim_proxy_alloc_fd: function (mode) {
    return ProcProxy.allocFd(mode);
  },

  // --------------------------------------------------------------------------
  // Phase 5 PTY entries (called from src/nvim/os/pty_proc_unix.c, EMSCRIPTEN +
  // nvim_proxy_active()-gated). A :terminal child runs on the server over ONE
  // bidirectional virtual fd; resize/exit ride pty.resize / pty.exit.
  // --------------------------------------------------------------------------

  // nvim_proxy_pty_dup_fd(fd): open a 2nd ('w') stream on fd's channel (the dup
  // of the pty master into proc->in). Returns the new fd or -1.
  nvim_proxy_pty_dup_fd__deps: ['$ProcProxy'],
  nvim_proxy_pty_dup_fd: function (fd) {
    return ProcProxy.ptyDupFd(fd);
  },

  // nvim_proxy_pty_spawn(handle, argvPtr, cwdPtr, envPtr, fd, fdIn, cols, rows):
  // register the pty, wire the input writer + push routing, fire `pty.spawn`
  // async with the initial size, return a local id. Exit/failure flow as a Proc.
  nvim_proxy_pty_spawn__deps: ['$ProcProxy'],
  nvim_proxy_pty_spawn: function (handle, argvPtr, cwdPtr, envPtr, fd, cols, rows) {
    // The C signature is (handle, argv, cwd, env, fd, cols, rows): the write-side
    // dup fd is found from the channel, but C also opens proc->in onto a dup whose
    // number we recover by scanning for the sibling sharing fd's channel.
    var fdIn = -1;
    var primary = ProcProxy.fds[fd];
    if (primary) {
      for (var k in ProcProxy.fds) {
        if (ProcProxy.fds[k] !== primary && ProcProxy.fds[k].ch === primary.ch) {
          fdIn = (k | 0);
          break;
        }
      }
    }
    return ProcProxy.spawnPty(handle, argvPtr, cwdPtr, envPtr, fd, fdIn, cols, rows);
  },

  // nvim_proxy_pty_resize(handle, cols, rows): forward a resize to the server pty.
  nvim_proxy_pty_resize__deps: ['$ProcProxy'],
  nvim_proxy_pty_resize: function (handle, cols, rows) {
    var entry = ProcProxy.byHandle[handle];
    if (!entry) { return; }
    var px = ProcProxy.proxy();
    if (!px) { return; }
    if (entry.serverId != null) {
      px.request('pty.resize', { id: entry.serverId, cols: (cols | 0), rows: (rows | 0) })
        .catch(function () {});
    } else {
      entry.resizeOnAck = { cols: (cols | 0), rows: (rows | 0) };
    }
  },

  // nvim_proxy_pty_kill(handle, signum): ask the server to kill the pty child
  // (the close path's analogue of hanging up the master). The server's pty.exit
  // push then drives the normal exit/close/refcount flow.
  nvim_proxy_pty_kill__deps: ['$ProcProxy'],
  nvim_proxy_pty_kill: function (handle, signum) {
    var entry = ProcProxy.byHandle[handle];
    if (!entry) { return; }
    var px = ProcProxy.proxy();
    if (!px) { return; }
    if (entry.serverId != null) {
      px.request('pty.kill', { id: entry.serverId, signal: signum }).catch(function () {});
    } else {
      entry.killOnAck = signum;
    }
  },

  // --------------------------------------------------------------------------
  // nvim_proxy_proc_spawn(handle, argvPtr, cwdPtr, envPtr, fdIn, fdOut, fdErr):
  // allocate a local child id, fire `proc.spawn` async, wire the stdin writer +
  // push routing, and return the local id synchronously. A spawn failure is
  // delivered through the exit path (status 127).
  // --------------------------------------------------------------------------
  nvim_proxy_proc_spawn__deps: ['$ProcProxy'],
  nvim_proxy_proc_spawn: function (handle, argvPtr, cwdPtr, envPtr, fdIn, fdOut, fdErr) {
    // Phase 3 nvim-Proc child: exit drives nvim_proxy_proc_on_exit (the default).
    return ProcProxy.spawnChild(handle, argvPtr, cwdPtr, envPtr, fdIn, fdOut, fdErr,
                                'nvim_proxy_proc_on_exit');
  },

  // --------------------------------------------------------------------------
  // nvim_uv_proxy_spawn(handle, argvPtr, cwdPtr, envPtr, fdIn, fdOut, fdErr):
  // Phase 4 -- register a uv_spawn child (LSP / vim.system / luv). Identical
  // wiring to the Proc path, but the server's `proc.exit` push must drive
  // uv_spawn's own exit_cb via nvim_uv_proxy_on_exit (see wasm/uv_stubs.c), so
  // the uv_process_t lifecycle (kill/exit/uv_close) completes correctly.
  // --------------------------------------------------------------------------
  nvim_uv_proxy_spawn__deps: ['$ProcProxy'],
  nvim_uv_proxy_spawn: function (handle, argvPtr, cwdPtr, envPtr, fdIn, fdOut, fdErr) {
    return ProcProxy.spawnChild(handle, argvPtr, cwdPtr, envPtr, fdIn, fdOut, fdErr,
                                'nvim_uv_proxy_on_exit');
  },

  // --------------------------------------------------------------------------
  // nvim_uv_proxy_kill(handle, signum): ask the server to signal a uv-spawn
  // child. (Same as the Proc kill; shares the byHandle table.)
  // --------------------------------------------------------------------------
  nvim_uv_proxy_kill__deps: ['$ProcProxy'],
  nvim_uv_proxy_kill: function (handle, signum) {
    var entry = ProcProxy.byHandle[handle];
    if (!entry) { return; }
    var px = ProcProxy.proxy();
    if (!px) { return; }
    if (entry.serverId != null) {
      px.request('proc.kill', { id: entry.serverId, signal: signum }).catch(function () {});
    } else {
      entry.killOnAck = signum;
    }
  },

  // --------------------------------------------------------------------------
  // nvim_uv_proxy_release(handle): drop the JS-side bookkeeping + free the
  // virtual fds for a uv-spawn child (called after uv_close tears the handle
  // down). Same as nvim_proxy_proc_release; shares the table.
  // --------------------------------------------------------------------------
  nvim_uv_proxy_release__deps: ['$ProcProxy'],
  nvim_uv_proxy_release: function (handle) {
    var entry = ProcProxy.byHandle[handle];
    if (!entry || entry.released) { return; }
    entry.released = true;
    ProcProxy.releaseEntry(entry);
  },

  // --------------------------------------------------------------------------
  // nvim_proxy_proc_kill(handle, signum): ask the server to signal the child.
  // --------------------------------------------------------------------------
  nvim_proxy_proc_kill__deps: ['$ProcProxy'],
  nvim_proxy_proc_kill: function (handle, signum) {
    var entry = ProcProxy.byHandle[handle];
    if (!entry) { return; }
    var px = ProcProxy.proxy();
    if (!px) { return; }
    if (entry.serverId != null) {
      px.request('proc.kill', { id: entry.serverId, signal: signum }).catch(function () {});
    } else {
      // Not acked yet: remember to kill on ack. Simplest: send once we get the id.
      entry.killOnAck = signum;
    }
  },

  // --------------------------------------------------------------------------
  // nvim_proxy_proc_release(handle): drop all JS-side bookkeeping for a proc
  // (called from proxy_proc_close, after the streams are closed). Frees the
  // virtual fds + the maps so a late push is dropped.
  // --------------------------------------------------------------------------
  nvim_proxy_proc_release__deps: ['$ProcProxy'],
  nvim_proxy_proc_release: function (handle) {
    var entry = ProcProxy.byHandle[handle];
    if (!entry || entry.released) { return; }
    entry.released = true;
    ProcProxy.releaseEntry(entry);
  },
});
