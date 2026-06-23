// wasm/nvim_io.js - Emscripten JS-library glue for Neovim's wasm build.
//
// Integrates Neovim's libuv event loop with Node/JSPI and provides the I/O for
// the "separate processes + message passing" architecture (see wasm/README.md
// and wasm/stage3.md). There are two roles, both built from this one binary:
//
//   * ENGINE (`nvim --embed`, runs in a worker): the JS host (wasm/worker.js in
//     Node, wasm/web/engine-worker.js in the browser) sets Module.nvimChannel to
//     a message channel before boot. We back fd 0/1 with that channel: fd 0 reads
//     bytes the host received over postMessage, fd 1 writes by handing bytes to
//     the host to postMessage onward. Set up in NvimIO.setup().
//
//   * CLIENT (the builtin TUI, runs on Node's main thread): keeps fd 0/1/2 for
//     the real terminal, spawns the engine worker, and talks to it over a second
//     message channel on two fresh fds. Set up in nvim_wasm_start_engine, which
//     the C ui_client_start_server() calls (builtin-UI mode only).
//
// Neither role blocks: nvim's poll() suspends asynchronously via JSPI and is
// resumed when a message arrives or the libuv timeout elapses. This is what lets
// us use postMessage at all -- a thread parked in a synchronous Atomics.wait
// would never return to its event loop to receive a message.
//
// A "channel" is a plain object shared (same realm/thread) between the host JS
// and this module:
//   { inQueue: [{buf,off}],   // bytes the host received; we drain on fd read
//     closed: bool,           // peer went away; fd read then reports EOF
//     notify: fn|null,        // we install it; host calls it after push/close
//     postOutput: fn(u8) }    // host provides; we call it on fd write
//
// poll(2) bits: POLLIN 0x001  POLLOUT 0x004  POLLERR 0x008  POLLHUP 0x010  POLLNVAL 0x020
// errno: EAGAIN 6  ESPIPE 70

addToLibrary({
  // Install channel/terminal stream ops from onRuntimeInitialized, NOT preRun:
  // the standard streams (fd 0/1/2) are created by FS.init() during initRuntime,
  // which runs *after* preRun. Installing in preRun would find no fd-0 stream.
  $NvimIO__postset:
    '(function(){var _p=Module["onRuntimeInitialized"];' +
    'Module["onRuntimeInitialized"]=function(){NvimIO.setup();if(_p){_p();}};})();',
  $NvimIO__deps: ['$FS'],
  $NvimIO: {
    dbg: function (m) {
      try {
        var p = (typeof process !== 'undefined') && process.env && process.env.NVIM_WASM_IO_LOG;
        if (p) { require('fs').appendFileSync(p, m + '\n'); }
      } catch (e) { /* ignore */ }
    },
    channel: null,        // message channel (engine: server side; client: to engine)
    clientMode: false,    // client (main-thread TUI): true
    stdinQueue: [],       // buffered real-terminal input (client): [{buf,off}]
    stdinEnded: false,
    wake: null,           // resolves the pending async poll; set during a wait
    engineWorker: null,

    // A single wake point: stdin, the engine channel, and the client channel all
    // call this after they enqueue data / close, to resume a suspended poll().
    signalWake: function () { if (NvimIO.wake) { NvimIO.wake(); } },

    setup: function () {
      var ch = Module['nvimChannel'];
      if (!ch) {
        return;  // CLIENT setup happens later, in nvim_wasm_start_engine.
      }
      // ENGINE role.
      NvimIO.channel = ch;
      ch.notify = NvimIO.signalWake;
      NvimIO.applyChannelOps(FS.getStream(0), ch, 'r');
      NvimIO.applyChannelOps(FS.getStream(1), ch, 'w');
    },

    // Install message-channel stream ops on an existing FS stream. mode 'r' reads
    // ch.inQueue; mode 'w' hands bytes to ch.postOutput. We keep stream.tty set
    // (callers ensure it): isatty(fd) must stay true so libuv's uv_guess_handle()
    // returns UV_TTY (the pipe path) rather than UV_FILE (which would read the fd
    // as a file and immediately EOF).
    applyChannelOps: function (stream, ch, mode) {
      if (!stream) {
        return;
      }
      stream.seekable = false;
      var EAGAIN = 6;
      var POLLIN = 0x001, POLLOUT = 0x004;
      stream.stream_ops = {
        read: function (stream, buffer, offset, length /*, position */) {
          var q = ch.inQueue;
          if (q.length === 0) {
            if (ch.closed) { return 0; }  // genuine EOF
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
        write: function (stream, buffer, offset, length /*, position */) {
          // Copy out of the wasm heap before handing bytes to the host: memory
          // growth can detach the heap's ArrayBuffer, and the host transfers the
          // buffer onward (postMessage), which needs it standalone.
          var u8 = new Uint8Array(buffer.buffer, (buffer.byteOffset || 0) + offset, length);
          ch.postOutput(u8.slice());
          return length;
        },
        poll: function (/* stream, timeout */) {
          var mask = 0;
          if (mode === 'r' && (ch.inQueue.length > 0 || ch.closed)) {
            mask |= POLLIN;
          }
          if (mode === 'w') {
            mask |= POLLOUT;  // the outbound queue is unbounded; always writable
          }
          return mask;
        },
        llseek: function () { throw new FS.ErrnoError(70); },
      };
    },

    // Create a fresh fd backed by the message channel (client side). Open
    // /dev/null (a real char-device node with a valid .mode so the FS read/write
    // wrappers don't choke) then swap in channel ops and a tty marker.
    makeChannelFd: function (ch, mode) {
      var stream = FS.open('/dev/null', mode === 'r' ? 'r' : 'w');
      NvimIO.applyChannelOps(stream, ch, mode);
      if (!stream.tty) {
        stream.tty = { ops: {} };
      }
      return stream.fd;
    },

    // Real-terminal size, for ioctl(TIOCGWINSZ) -> [rows, cols].
    winsize: function () {
      var rows = 24, cols = 80;
      try {
        if (process.stdout && process.stdout.rows) { rows = process.stdout.rows; }
        if (process.stdout && process.stdout.columns) { cols = process.stdout.columns; }
      } catch (e) { /* keep defaults */ }
      return [rows, cols];
    },

    // CLIENT: back fd 0 with the buffered real-stdin queue, fd 1/2 with raw
    // writes to the real terminal, and make TIOCGWINSZ report the real size.
    installHostTerminal: function () {
      var EAGAIN = 6;
      var POLLIN = 0x001, POLLOUT = 0x004;

      var s0 = FS.getStream(0);
      if (s0) {
        s0.seekable = false;
        s0.stream_ops = {
          read: function (stream, buffer, offset, length /*, position */) {
            var q = NvimIO.stdinQueue;
            if (q.length === 0) {
              if (NvimIO.stdinEnded) { return 0; }
              throw new FS.ErrnoError(EAGAIN);
            }
            var n = 0;
            while (n < length && q.length > 0) {
              var head = q[0];
              var avail = head.buf.length - head.off;
              var take = Math.min(avail, length - n);
              for (var i = 0; i < take; i++) {
                buffer[offset + n + i] = head.buf[head.off + i];
              }
              head.off += take;
              n += take;
              if (head.off >= head.buf.length) { q.shift(); }
            }
            return n;
          },
          write: function () { throw new FS.ErrnoError(EAGAIN); },
          poll: function () {
            return (NvimIO.stdinQueue.length > 0 || NvimIO.stdinEnded) ? POLLIN : 0;
          },
          llseek: function () { throw new FS.ErrnoError(70); },
        };
      }

      function outStreamOps(sink) {
        return {
          read: function () { throw new FS.ErrnoError(6); },
          write: function (stream, buffer, offset, length /*, position */) {
            var u8 = new Uint8Array(buffer.buffer, (buffer.byteOffset || 0) + offset, length);
            sink(Buffer.from(u8));
            return length;
          },
          poll: function () { return POLLOUT; },
          llseek: function () { throw new FS.ErrnoError(70); },
        };
      }
      var s1 = FS.getStream(1);
      if (s1) { s1.seekable = false; s1.stream_ops = outStreamOps(function (b) { process.stdout.write(b); }); }
      var s2 = FS.getStream(2);
      if (s2) { s2.seekable = false; s2.stream_ops = outStreamOps(function (b) { process.stderr.write(b); }); }

      [s0, s1, s2].forEach(function (s) {
        if (s && s.tty) {
          s.tty.ops = s.tty.ops || {};
          s.tty.ops.ioctl_tiocgwinsz = function () { return NvimIO.winsize(); };
        }
      });
    },

    // CLIENT: put the real terminal in raw mode and pump its input into the
    // queue, waking any pending async poll on each chunk.
    enableRawMode: function () {
      if (NvimIO._rawDone) {
        return;
      }
      NvimIO._rawDone = true;
      try {
        if (process.stdin.isTTY) { process.stdin.setRawMode(true); }
      } catch (e) { /* not a tty (e.g. piped) */ }
      process.stdin.on('data', function (d) {
        NvimIO.stdinQueue.push({ buf: d, off: 0 });
        NvimIO.signalWake();
      });
      process.stdin.on('end', function () {
        NvimIO.stdinEnded = true;
        NvimIO.signalWake();
      });
      process.stdin.resume();
      process.on('exit', function () {
        try { if (process.stdin.isTTY) { process.stdin.setRawMode(false); } } catch (e) { /* ignore */ }
      });
    },

    // Async (non-blocking) wait used by __syscall_poll. Resolves when any input
    // source becomes readable (a message arrives, terminal stdin, or a close --
    // all of which call signalWake) or the libuv timeout elapses.
    //
    // Wakeups come from real platform events (worker 'message', stdin 'data',
    // setTimeout), i.e. macrotasks, so there is no microtask busy-spin and the
    // wall clock the C event loop relies on (os_hrtime) keeps advancing. We do
    // NOT resolve synchronously here: __syscall_poll only calls this after a
    // compute() that already found nothing ready, so there is nothing to race.
    pollWaitAsync: function (timeout) {
      return new Promise(function (resolve) {
        var done = false;
        var prevWake = NvimIO.wake;
        function finish() {
          if (done) { return; }
          done = true;
          if (timer) { clearTimeout(timer); }
          NvimIO.wake = prevWake;
          resolve();
        }
        var timer = timeout > 0 ? setTimeout(finish, timeout) : null;
        NvimIO.wake = finish;
      });
    },
  },

  // C entry point (ui_client_start_server, wasm only): spawn the engine worker,
  // wire up the client side of the message channel + the real terminal, and hand
  // the client-side read/write fds back to C via *inFdPtr / *outFdPtr. Node only
  // (the browser has no wasm UI client -- the page drives the engine directly).
  nvim_wasm_start_engine__deps: ['$NvimIO', '$FS'],
  nvim_wasm_start_engine: function (inFdPtr, outFdPtr) {
    function fail(e) {
      try { process.stderr.write('nvim_wasm_start_engine failed: ' + (e && e.stack || e) + '\n'); } catch (_e) {}
      HEAP32[inFdPtr >> 2] = -1;
      HEAP32[outFdPtr >> 2] = -1;
    }
    try {
      var path = require('path');
      var dir = __dirname;
      var worker_threads = require('worker_threads');

      // The engine runs the same nvim args as this client (it opens the files).
      // Use the pristine copy: Module['arguments'] was mutated by callMain().
      var args = (Module['nvimUserArgs'] || Module['arguments'] || []).slice();
      var worker = new worker_threads.Worker(path.join(dir, 'worker.js'), {
        workerData: { args: args },
        stdout: true, stderr: true,  // capture, don't let it corrupt the TUI
      });
      NvimIO.engineWorker = worker;

      var chan = {
        inQueue: [],
        closed: false,
        notify: NvimIO.signalWake,
        postOutput: function (u8) { worker.postMessage(u8.buffer, [u8.buffer]); },
      };
      worker.on('message', function (d) {
        chan.inQueue.push({ buf: new Uint8Array(d), off: 0 });
        NvimIO.signalWake();
      });
      // Engine gone (e.g. :q) -> EOF on the channel -> client teardown.
      worker.on('exit', function () { chan.closed = true; NvimIO.signalWake(); });
      worker.on('error', function (e) { chan.closed = true; NvimIO.signalWake(); NvimIO.dbg('engine worker error: ' + e); });

      // Drain the engine's stray stdout/stderr to an optional log file.
      var logPath = process.env.NVIM_WASM_ENGINE_LOG;
      var sink = logPath ? require('fs').createWriteStream(logPath) : null;
      worker.stdout.on('data', function (d) { if (sink) { sink.write(d); } });
      worker.stderr.on('data', function (d) { if (sink) { sink.write(d); } });

      NvimIO.channel = chan;
      NvimIO.clientMode = true;
      NvimIO.enableRawMode();
      NvimIO.installHostTerminal();

      var in_fd = NvimIO.makeChannelFd(chan, 'r');
      var out_fd = NvimIO.makeChannelFd(chan, 'w');
      NvimIO.dbg('nvim_wasm_start_engine: in_fd=' + in_fd + ' out_fd=' + out_fd);
      HEAP32[inFdPtr >> 2] = in_fd;
      HEAP32[outFdPtr >> 2] = out_fd;
    } catch (e) {
      fail(e);
    }
  },

  // Replacement for Emscripten's __syscall_poll. Computes fd readiness without
  // crashing on streams that lack a poll op, then -- when nothing is ready --
  // suspends asynchronously via JSPI until a source wakes us or the timeout
  // elapses. Both roles (engine in a worker, client on the main thread) use the
  // same async path; nothing blocks.
  __syscall_poll__deps: ['$FS', '$NvimIO'],
  __syscall_poll__async: true,
  __syscall_poll: function (fds, nfds, timeout) {
    var POLLIN = 0x001, POLLOUT = 0x004, POLLNVAL = 0x020;

    function compute() {
      var n = 0;
      for (var i = 0; i < nfds; i++) {
        var pollfd = fds + 8 * i;
        var fd = HEAP32[pollfd >> 2];
        var events = HEAP16[(pollfd + 4) >> 1];
        var revents;
        var stream = FS.getStream(fd);
        if (!stream) {
          revents = POLLNVAL;
        } else if (stream.stream_ops && stream.stream_ops.poll) {
          revents = stream.stream_ops.poll(stream, -1) & events;
        } else {
          revents = events & (POLLIN | POLLOUT);
        }
        HEAP16[(pollfd + 6) >> 1] = revents;
        if (revents) {
          n++;
        }
      }
      return n;
    }

    var ready = compute();
    if (ready > 0 || timeout === 0) {
      return ready;
    }
    return NvimIO.pollWaitAsync(timeout).then(compute);
  },
});
