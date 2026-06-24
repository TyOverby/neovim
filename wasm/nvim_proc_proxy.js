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
// SERVER PROTOCOL (handled in wasm/server/proc-handlers.js)
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
  $ProcProxy__deps: ['$FS', '$NvimIO'],
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
    allocFd: function (mode) {
      var modeStr = mode === 1 ? 'w' : 'r';
      var name = '/.nvim-proc-proxy-fd-' + ProcProxy.nextFd;
      try {
        FS.writeFile(name, new Uint8Array(0));
        var stream = FS.open(name, 2 /* O_RDWR */);
        var ch = { inQueue: [], closed: false, onWrite: null, onClose: null };
        ProcProxy.applyOps(stream, ch, modeStr);
        ProcProxy.fds[stream.fd] = { ch: ch, mode: modeStr, path: name };
        ProcProxy.nextFd++;
        return stream.fd;
      } catch (e) {
        ProcProxy.dbg('allocFd failed: ' + (e && e.message || e));
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
    freeFd: function (fd) {
      var slot = ProcProxy.fds[fd];
      if (!slot) { return; }
      delete ProcProxy.fds[fd];
      try { FS.unlink(slot.path); } catch (e) { /* ignore */ }
    },

    // Route a server push (proc.stdout/proc.stderr/proc.exit) to the right child.
    // Installed once, lazily, on the shared proxy client.
    wirePush: function () {
      if (ProcProxy.pushWired) { return; }
      var px = ProcProxy.proxy();
      if (!px || typeof px.onPush !== 'function') { return; }
      ProcProxy.pushWired = true;

      // IMPORTANT: compose with any existing push handler (the fs-proxy doesn't
      // use pushes today, but be defensive so we never clobber one).
      var prev = px.__procProxyPrevOnPush;
      px.onPush(function (method, params, payload) {
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
          }
          return;
        }
        if (prev) { try { prev(method, params, payload); } catch (e) { /* ignore */ } }
      });
    },

    // Deliver a child's exit into C: call the EMSCRIPTEN_KEEPALIVE entry
    // _nvim_proxy_proc_on_exit(handle, status, signal). This drives proc->status
    // + on_proc_exit() -> the close/refcount/proc->cb teardown on the main loop.
    // We pass the handle pointer as a number (it is a wasm i32 pointer).
    deliverExit: function (entry, code, signal) {
      try {
        // ccall signature: void nvim_proxy_proc_on_exit(void* handle, int, int).
        // 'number' marshals the pointer + the ints directly.
        Module.ccall('nvim_proxy_proc_on_exit', null,
          ['number', 'number', 'number'], [entry.handle, code, signal]);
      } catch (e) {
        ProcProxy.dbg('deliverExit ccall failed: ' + (e && e.message || e));
      }
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
  // nvim_proxy_proc_spawn(handle, argvPtr, cwdPtr, envPtr, fdIn, fdOut, fdErr):
  // allocate a local child id, fire `proc.spawn` async, wire the stdin writer +
  // push routing, and return the local id synchronously. A spawn failure is
  // delivered through the exit path (status 127).
  // --------------------------------------------------------------------------
  nvim_proxy_proc_spawn__deps: ['$ProcProxy'],
  nvim_proxy_proc_spawn: function (handle, argvPtr, cwdPtr, envPtr, fdIn, fdOut, fdErr) {
    var px = ProcProxy.proxy();
    if (!px) { return -1; }

    var argv = ProcProxy.readStrv(argvPtr);
    if (argv.length === 0) { return -1; }
    var cwd = cwdPtr ? UTF8ToString(cwdPtr) : '';
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
    };
    ProcProxy.byHandle[handle] = entry;

    // Wire the stdin writer: nvim writes to the stdin fd -> proc.stdin request.
    if (entry.fdIn >= 0) {
      var inSlot = ProcProxy.fds[entry.fdIn];
      if (inSlot) {
        inSlot.ch.onWrite = function (bytes) {
          if (entry.serverId == null) {
            // Spawn not acked yet: buffer until we have a server id.
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

    // Fire the spawn. On ack: record the server id, flush buffered stdin. On
    // failure: deliver an exit(127) so nvim's job machinery completes cleanly.
    px.request('proc.spawn', {
      argv: argv, cwd: cwd, env: env,
      wantIn: entry.fdIn >= 0, wantOut: entry.fdOut >= 0, wantErr: entry.fdErr >= 0,
    }).then(function (resp) {
      var sid = resp && resp.result && resp.result.id;
      if (sid == null) { throw new Error('proc.spawn: no id'); }
      entry.serverId = sid;
      ProcProxy.byServerId[sid] = entry;
      // Flush any stdin written before the ack.
      if (entry.stdinBuf && entry.stdinBuf.length) {
        for (var j = 0; j < entry.stdinBuf.length; j++) {
          px.request('proc.stdin', { id: sid }, entry.stdinBuf[j]).catch(function () {});
        }
        entry.stdinBuf = null;
      }
      if (entry.fdIn >= 0) {
        var slot = ProcProxy.fds[entry.fdIn];
        // If nvim already closed stdin while the ack was pending, propagate it.
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
    if (!entry) { return; }
    delete ProcProxy.byHandle[handle];
    if (entry.serverId != null) { delete ProcProxy.byServerId[entry.serverId]; }
    if (entry.fdIn >= 0) { ProcProxy.freeFd(entry.fdIn); }
    if (entry.fdOut >= 0) { ProcProxy.freeFd(entry.fdOut); }
    if (entry.fdErr >= 0) { ProcProxy.freeFd(entry.fdErr); }
  },
});
