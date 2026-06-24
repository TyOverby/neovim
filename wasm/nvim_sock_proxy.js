// wasm/nvim_sock_proxy.js - Emscripten JS-library: the TCP socket + DNS proxy
// backend's JS half (Stage 4 -- the last IO seam). Pairs with the socket wraps
// in wasm/uv_stubs.c (__wrap_uv_tcp_connect / __wrap_uv_getaddrinfo /
// __wrap_uv_freeaddrinfo).
//
// ============================================================================
// WHAT THIS DOES
// ============================================================================
// When the engine worker is configured with an IO-proxy (globalThis.__nvimProxy),
// outbound TCP connections (sockconnect('tcp',...), vim.uv.tcp:connect(), and any
// libuv uv_tcp_connect) AND DNS lookups (uv_getaddrinfo) run on the SERVER. The
// connected socket's bytes ride a VIRTUAL bidirectional pollable fd -- the SAME
// MEMFS-backed mechanism the spawn-stdio proxy (nvim_proc_proxy.js) uses, proven
// by SPIKE S1: uv_tcp_open(handle, fd) accepts it with no real socket.
//
// ============================================================================
// HARD INVARIANT (binding): ADDITIVE + OPT-IN
// ============================================================================
// With NO proxy configured, nvim_proxy_active() returns 0, so the C wraps fall
// through to __real_uv_* and none of this code runs.
//
// ============================================================================
// THE SYNC-CONNECT / ASYNC-SERVER SEAM
// ============================================================================
// C's __wrap_uv_tcp_connect returns 0 immediately (like real uv_tcp_connect),
// having registered the connect req. nvim_sock_connect fires `sock.connect` in
// the background; the server's reply carries a connection id (or an error). On
// success we map the id -> the fd + req so later sock.data pushes route, and we
// ccall nvim_sock_on_connect(req, 0). On failure we close the fd and ccall
// nvim_sock_on_connect(req, UV_ECONNREFUSED) so socket.c retries / reports
// "connection refused" rather than hanging.
//
// getaddrinfo has two forms:
//   * SYNC (socket.c, cb==NULL): nvim_sock_resolve_sync is __async -- it
//     round-trips `sock.getaddrinfo` and SUSPENDS the wasm frame via JSPI, then
//     stashes the resolved port + status for the C wrap to read back.
//   * ASYNC (luv, cb!=NULL): nvim_sock_register_async stashes the req, fires
//     `sock.getaddrinfo` in the background, and ccalls nvim_sock_on_addrinfo_queued
//     later.
//
// ============================================================================
// SERVER PROTOCOL (handled in wasm/server/sock-handlers.js)
// ============================================================================
//   sock.connect     {host, port}            -> {id}        (server connection id)
//   sock.write       {id} + payload<bytes>   -> {ok}        (write to the socket)
//   sock.close       {id}                    -> {ok}        (end/destroy the socket)
//   sock.getaddrinfo {host, service}         -> {addrs:[{family,address,port}]}
//   server pushes:
//     sock.connect_ok  {id}                  (the connect succeeded)
//     sock.connect_err {id, code}            (the connect failed; code = string)
//     sock.data        {id} + payload<bytes> (inbound socket bytes)
//     sock.closed      {id}                  (the peer closed / EOF)
// ============================================================================

addToLibrary({
  // --------------------------------------------------------------------------
  // $SockProxy: shared state + helpers. Reads the proxy lazily off globalThis so
  // the library links cleanly with or without one. Self-contained (its own fd
  // table + push wiring) so it does not depend on $ProcProxy load order, but it
  // composes its onPush handler with any already-installed one (the proc proxy).
  // --------------------------------------------------------------------------
  $SockProxy__deps: ['$FS', '$NvimIO'],
  $SockProxy: {
    nextFd: 300000,          // virtual socket fds, above the proc-proxy range
    fds: {},                 // fd -> { ch }
    byId: {},                // server connection id -> entry
    byReq: {},               // connect req ptr -> entry (pre-id)
    asyncReqs: {},           // async getaddrinfo req ptr -> { req }
    pushWired: false,
    syncPort: 0,             // result of the last SYNC getaddrinfo
    syncStatus: 0,           // status of the last SYNC getaddrinfo (0 = ok)

    dbg: function (m) {
      try {
        if (typeof process !== 'undefined' && process.env && process.env.NVIM_SOCK_PROXY_LOG) {
          if (typeof err === 'function') { err('[sock-proxy] ' + m); }
        }
      } catch (e) { /* ignore */ }
    },

    proxy: function () {
      return (typeof globalThis !== 'undefined' && globalThis.__nvimProxy) || null;
    },

    // Wake the JSPI-suspended __syscall_poll (wasm/nvim_io.js).
    wake: function () { NvimIO.signalWake(); },

    // Install message-channel-style pollable stream ops on an FS stream -- a
    // BIDIRECTIONAL socket: read drains ch.inQueue (server sock.data); write
    // hands bytes to the server (ch.onWrite -> sock.write); close -> ch.onClose
    // (-> sock.close). Same shape as nvim_proc_proxy.js applyOps, but one fd is
    // both readable and writable (a socket, not a unidirectional pipe).
    applyOps: function (stream, ch) {
      var EAGAIN = 6, ESPIPE = 70;
      var POLLIN = 0x001, POLLOUT = 0x004;
      stream.seekable = false;
      // tty marker so uv_guess_handle(fd) returns UV_TTY (the pipe/stream path),
      // not UV_FILE. (For the connect wrap we uv_tcp_open directly, so this is
      // belt-and-suspenders, matching the spawn-stdio fds.)
      stream.tty = { ops: {} };
      stream.stream_ops = {
        read: function (stream, buffer, offset, length) {
          var q = ch.inQueue;
          if (!q || q.length === 0) {
            if (ch.closed) { return 0; }   // genuine EOF (peer closed)
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
          // Copy out of the wasm heap (memory growth can detach it; bytes ride a
          // proxy frame asynchronously).
          var u8 = new Uint8Array(buffer.buffer, (buffer.byteOffset || 0) + offset, length);
          if (ch.onWrite) { ch.onWrite(u8.slice()); }
          return length;
        },
        poll: function (stream, timeout) {
          var mask = 0;
          if ((ch.inQueue && ch.inQueue.length > 0) || ch.closed) { mask |= POLLIN; }
          // Always writable from nvim's side (the server buffers / backpressures).
          mask |= POLLOUT;
          return mask;
        },
        // nvim closing the socket (uv_close -> fd close) lands here: tell the
        // server to end/destroy the real socket.
        close: function (stream) {
          if (!ch.closed) { ch.closed = true; }
          if (ch.onClose) { ch.onClose(); }
        },
        llseek: function () { throw new FS.ErrnoError(ESPIPE); },
      };
    },

    // Allocate a virtual bidirectional pollable fd. Opens a real MEMFS file to
    // get a first-class FS stream (so fcntl works for uv_tcp_open), O_RDWR so
    // libuv marks the handle readable+writable, then swaps in the pollable ops.
    allocFd: function () {
      var name = '/.nvim-sock-proxy-fd-' + SockProxy.nextFd;
      try {
        FS.writeFile(name, new Uint8Array(0));
        var stream = FS.open(name, 2 /* O_RDWR */);
        var ch = { inQueue: [], closed: false, onWrite: null, onClose: null };
        SockProxy.applyOps(stream, ch);
        SockProxy.fds[stream.fd] = { ch: ch, path: name };
        SockProxy.nextFd++;
        return stream.fd;
      } catch (e) {
        SockProxy.dbg('allocFd failed: ' + (e && e.message || e));
        return -1;
      }
    },

    // Enqueue inbound bytes onto a fd's channel + wake poll (server sock.data).
    pushBytes: function (fd, bytes) {
      var slot = SockProxy.fds[fd];
      if (!slot) { return; }
      slot.ch.inQueue.push({ buf: bytes, off: 0 });
      SockProxy.wake();
    },

    // Mark a fd's channel closed (EOF) + wake poll (server sock.closed).
    eofFd: function (fd) {
      var slot = SockProxy.fds[fd];
      if (!slot) { return; }
      slot.ch.closed = true;
      SockProxy.wake();
    },

    // Free the MEMFS backing of a virtual fd. Best-effort; the uv handle wrapping
    // it was/will be uv_close()'d by nvim's stream teardown.
    freeFd: function (fd) {
      var slot = SockProxy.fds[fd];
      if (!slot) { return; }
      delete SockProxy.fds[fd];
      try { FS.unlink(slot.path); } catch (e) { /* ignore */ }
    },

    // Drop all JS-side bookkeeping for a connection entry. Idempotent.
    releaseEntry: function (entry) {
      if (!entry) { return; }
      if (entry.serverId != null) { delete SockProxy.byId[entry.serverId]; }
      if (entry.req != null) { delete SockProxy.byReq[entry.req]; }
      if (entry.fd >= 0) { SockProxy.freeFd(entry.fd); }
    },

    // Route a server push (sock.connect_ok/err, sock.data, sock.closed) to the
    // right connection. Installed once, lazily, composing with any existing
    // handler (the proc proxy's) so we never clobber it.
    wirePush: function () {
      if (SockProxy.pushWired) { return; }
      var px = SockProxy.proxy();
      if (!px || typeof px.onPush !== 'function') { return; }
      SockProxy.pushWired = true;

      // Compose: chain to whatever handler is currently installed (the proc
      // proxy records its handler in px.__nvimPushChain) and record ourselves
      // there so a later wirePush chains to US. Order-independent.
      var prev = px.__nvimPushChain || null;
      var handler = function (method, params, payload) {
        var id = params && params.id;
        if (method === 'sock.connect_ok') {
          var e1 = (id != null) ? SockProxy.byId[id] : null;
          if (e1 && !e1.settled) {
            e1.settled = true;
            SockProxy.deliverConnect(e1, 0);
          }
          return;
        }
        if (method === 'sock.connect_err') {
          var e2 = (id != null) ? SockProxy.byId[id] : null;
          if (e2 && !e2.settled) {
            e2.settled = true;
            // EOF + close the fd, then deliver UV_ECONNREFUSED (-4078).
            if (e2.fd >= 0) { SockProxy.eofFd(e2.fd); }
            SockProxy.deliverConnect(e2, SockProxy.UV_ECONNREFUSED);
            // The handle teardown (uv_close -> fd close) will fire ch.onClose ->
            // sock.close; release our bookkeeping after that settles.
            var refused = e2;
            setTimeout(function () { SockProxy.releaseEntry(refused); }, 0);
          }
          return;
        }
        if (method === 'sock.data') {
          var e3 = (id != null) ? SockProxy.byId[id] : null;
          if (e3 && e3.fd >= 0 && payload && payload.length) {
            SockProxy.pushBytes(e3.fd, payload.slice ? payload.slice() : new Uint8Array(payload));
          }
          return;
        }
        if (method === 'sock.closed') {
          var e4 = (id != null) ? SockProxy.byId[id] : null;
          if (e4 && e4.fd >= 0) { SockProxy.eofFd(e4.fd); }
          return;
        }
        if (prev) { try { prev(method, params, payload); } catch (e) { /* ignore */ } }
      };
      px.__nvimPushChain = handler;
      px.onPush(handler);
    },

    UV_ECONNREFUSED: -4078,  // libuv's UV_ECONNREFUSED (errno mapped to a uv code)
    UV_EAI_FAIL: -3003,      // libuv's UV_EAI_FAIL (getaddrinfo failure)

    // Deliver a connect result into C. CRITICAL: the connect cb we ultimately
    // fire (socket.c's connect_cb / luv's) re-enters the event loop and can hit
    // the JSPI-suspending __syscall_poll, so it MUST run on the engine's MAIN
    // (suspendable) stack -- NOT a plain ccall from this macrotask (which would
    // abort with "trying to suspend without WebAssembly.promising"). So we only
    // ENQUEUE the (req, status) into C and wake the poll; a uv_check registered
    // on the loop drains the queue and fires the cb INSIDE uv_run (see
    // wasm/uv_stubs.c). The ccall here just enqueues + returns immediately.
    deliverConnect: function (entry, status) {
      try {
        Module.ccall('nvim_sock_on_connect', null,
          ['number', 'number'], [entry.req, status | 0]);
      } catch (e) {
        SockProxy.dbg('nvim_sock_on_connect enqueue failed: ' + (e && e.message || e));
      }
      SockProxy.wake();  // resume the suspended poll so the loop runs the check
    },
  },

  // --------------------------------------------------------------------------
  // nvim_sock_alloc_fd(): allocate a virtual bidirectional socket fd. Returns the
  // fd or -1. Called by __wrap_uv_tcp_connect before uv_tcp_open(handle, fd).
  // --------------------------------------------------------------------------
  nvim_sock_alloc_fd__deps: ['$SockProxy'],
  nvim_sock_alloc_fd: function () {
    return SockProxy.allocFd();
  },

  // --------------------------------------------------------------------------
  // nvim_sock_connect(req, handle, fd, hostPtr, port): register the connect (so
  // a later server push finds the req/fd), wire the socket's write/close to the
  // server, and fire `sock.connect` async. The reply -> nvim_sock_on_connect.
  // --------------------------------------------------------------------------
  nvim_sock_connect__deps: ['$SockProxy'],
  nvim_sock_connect: function (req, handle, fd, hostPtr, port) {
    var px = SockProxy.proxy();
    var host = hostPtr ? UTF8ToString(hostPtr) : '';
    var slot = SockProxy.fds[fd];
    var entry = {
      req: req, handle: handle, fd: (fd | 0), serverId: null,
      settled: false, host: host, port: (port | 0),
    };
    SockProxy.byReq[req] = entry;

    // Wire the socket's outbound writes + close to the server. Buffer writes that
    // happen before the server id arrives (rare: nvim waits for connect_cb first,
    // but be safe).
    if (slot) {
      slot.ch.onWrite = function (bytes) {
        if (entry.serverId == null) {
          (entry.outBuf || (entry.outBuf = [])).push(bytes);
          return;
        }
        px.request('sock.write', { id: entry.serverId }, bytes)
          .catch(function () { /* socket gone; reads will EOF */ });
      };
      slot.ch.onClose = function () {
        if (entry.serverId != null && !entry.closeSent) {
          entry.closeSent = true;
          px.request('sock.close', { id: entry.serverId }).catch(function () {});
        } else {
          entry.closeOnAck = true;
        }
      };
    }

    SockProxy.wirePush();

    if (!px) {
      // No proxy (shouldn't happen: the C wrap only calls in when active) ->
      // fail the connect cleanly.
      SockProxy.eofFd(fd);
      SockProxy.deliverConnect(entry, SockProxy.UV_ECONNREFUSED);
      return;
    }

    px.request('sock.connect', { host: host, port: (port | 0) }).then(function (resp) {
      var sid = resp && resp.result && resp.result.id;
      if (sid == null) { throw new Error('sock.connect: no id'); }
      entry.serverId = sid;
      SockProxy.byId[sid] = entry;
      // Flush any buffered writes that raced ahead of the id.
      if (entry.outBuf && entry.outBuf.length) {
        for (var j = 0; j < entry.outBuf.length; j++) {
          px.request('sock.write', { id: sid }, entry.outBuf[j]).catch(function () {});
        }
        entry.outBuf = null;
      }
      if (entry.closeOnAck && !entry.closeSent) {
        entry.closeSent = true;
        px.request('sock.close', { id: sid }).catch(function () {});
      }
      // The server pushes sock.connect_ok / sock.connect_err separately (a
      // 'connect' event or an 'error'); the connect result is delivered there.
    }, function (e) {
      SockProxy.dbg('sock.connect request failed: ' + (e && e.message || e));
      if (!entry.settled) {
        entry.settled = true;
        SockProxy.eofFd(fd);
        SockProxy.deliverConnect(entry, SockProxy.UV_ECONNREFUSED);
        SockProxy.releaseEntry(entry);
      }
    });
  },

  // --------------------------------------------------------------------------
  // nvim_sock_close_fd(fd): free a virtual socket fd's MEMFS backing (used by the
  // C wrap's alloc-failure path; normal teardown frees via releaseEntry).
  // --------------------------------------------------------------------------
  nvim_sock_close_fd__deps: ['$SockProxy'],
  nvim_sock_close_fd: function (fd) {
    SockProxy.freeFd(fd);
  },

  // --------------------------------------------------------------------------
  // nvim_sock_register_async(req, hostPtr, servicePtr): register an ASYNC
  // getaddrinfo req (luv), fire `sock.getaddrinfo`, and ccall
  // nvim_sock_on_addrinfo_queued later with the resolved port (== the requested service
  // number; DNS only resolves the host, which the proxy carries separately).
  // --------------------------------------------------------------------------
  nvim_sock_register_async__deps: ['$SockProxy'],
  nvim_sock_register_async: function (req, hostPtr, servicePtr) {
    var px = SockProxy.proxy();
    var host = hostPtr ? UTF8ToString(hostPtr) : '';
    var service = servicePtr ? UTF8ToString(servicePtr) : '';
    var port = parseInt(service, 10);
    if (!isFinite(port)) { port = 0; }

    // Enqueue the result into C + wake the poll; the uv_check drain fires the luv
    // getaddrinfo cb on the main (suspendable) frame (it may chain into a connect
    // that re-enters the suspending poll loop). Same deferral as deliverConnect.
    function fire(status, p) {
      try {
        Module.ccall('nvim_sock_on_addrinfo_queued', null,
          ['number', 'number', 'number'], [req, status | 0, p | 0]);
      } catch (e) {
        SockProxy.dbg('nvim_sock_on_addrinfo_queued enqueue failed: ' + (e && e.message || e));
      }
      SockProxy.wake();
    }

    if (!px) { fire(SockProxy.UV_EAI_FAIL, 0); return; }

    px.request('sock.getaddrinfo', { host: host, service: service }).then(function (resp) {
      var addrs = (resp && resp.result && resp.result.addrs) || [];
      if (!addrs.length) { fire(SockProxy.UV_EAI_FAIL, 0); return; }
      // Use the resolved port if the server returned one, else the requested.
      var p = (typeof addrs[0].port === 'number' && addrs[0].port) ? addrs[0].port : port;
      fire(0, p);
    }, function (e) {
      SockProxy.dbg('sock.getaddrinfo (async) failed: ' + (e && e.message || e));
      fire(SockProxy.UV_EAI_FAIL, 0);
    });
  },

  // --------------------------------------------------------------------------
  // nvim_sock_resolve_sync(hostPtr, servicePtr) [__async]: the SYNC getaddrinfo
  // (socket.c). Round-trip `sock.getaddrinfo` and SUSPEND the wasm frame via JSPI
  // (the same mechanism nvim_fs_proxy.js uses). Stash the resolved port + status
  // for the C wrap to read back via nvim_sock_take_sync_port / _status.
  // --------------------------------------------------------------------------
  nvim_sock_resolve_sync__deps: ['$SockProxy'],
  nvim_sock_resolve_sync__async: true,
  nvim_sock_resolve_sync: function (hostPtr, servicePtr) {
    var px = SockProxy.proxy();
    var host = hostPtr ? UTF8ToString(hostPtr) : '';
    var service = servicePtr ? UTF8ToString(servicePtr) : '';
    var port = parseInt(service, 10);
    if (!isFinite(port)) { port = 0; }
    SockProxy.syncPort = port;
    SockProxy.syncStatus = 0;

    if (!px) { SockProxy.syncStatus = SockProxy.UV_EAI_FAIL; return Promise.resolve(); }

    return px.request('sock.getaddrinfo', { host: host, service: service }).then(function (resp) {
      var addrs = (resp && resp.result && resp.result.addrs) || [];
      if (!addrs.length) { SockProxy.syncStatus = SockProxy.UV_EAI_FAIL; return; }
      if (typeof addrs[0].port === 'number' && addrs[0].port) { SockProxy.syncPort = addrs[0].port; }
      SockProxy.syncStatus = 0;
    }, function (e) {
      SockProxy.dbg('sock.getaddrinfo (sync) failed: ' + (e && e.message || e));
      SockProxy.syncStatus = SockProxy.UV_EAI_FAIL;
    });
  },

  // --------------------------------------------------------------------------
  // nvim_sock_take_sync_port() / nvim_sock_take_sync_status(): read back the
  // result of the last SYNC getaddrinfo (set by nvim_sock_resolve_sync after the
  // JSPI resume). Separate calls so the C wrap reads status then port.
  // --------------------------------------------------------------------------
  nvim_sock_take_sync_port__deps: ['$SockProxy'],
  nvim_sock_take_sync_port: function () {
    return SockProxy.syncPort | 0;
  },

  nvim_sock_take_sync_status__deps: ['$SockProxy'],
  nvim_sock_take_sync_status: function () {
    return SockProxy.syncStatus | 0;
  },
});
