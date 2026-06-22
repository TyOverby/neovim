// wasm/nvim_io.js - Emscripten JS-library glue for Neovim's wasm build.
//
// Integrates Neovim's libuv event loop with Node/JSPI and provides the I/O for
// the "separate processes + shared memory" architecture (see wasm/README.md and
// wasm/stage2.md). There are two roles, both built from this one binary:
//
//   * ENGINE (`nvim --embed`, runs in a worker_thread): the JS host sets
//     Module.nvimServerChannel to a RingChannel (wasm/sab.js) before boot. We
//     back fd 0/1 with that channel and block in poll() via Atomics.wait
//     (allowed off the main thread). This is set up in NvimIO.setup().
//
//   * CLIENT (the builtin TUI, runs on the main thread): keeps fd 0/1/2 for the
//     real terminal, spawns the engine worker, and talks to it over a second
//     RingChannel on two fresh fds. The main thread must never block, so poll()
//     suspends asynchronously via JSPI. This is set up in nvim_wasm_start_engine,
//     which the C ui_client_start_server() calls (builtin-UI mode only).
//
// poll(2) bits: POLLIN 0x001  POLLOUT 0x004  POLLERR 0x008  POLLHUP 0x010  POLLNVAL 0x020
// errno: EAGAIN 6  ESPIPE 70

addToLibrary({
  // Install channel/terminal stream ops from onRuntimeInitialized, NOT preRun:
  // the standard streams (fd 0/1/2) are created by FS.init() during initRuntime,
  // which runs *after* preRun. Installing in preRun would find no fd-0 stream
  // (FS.getStream(0) === undefined) and silently no-op.
  $NvimIO__postset:
    '(function(){var _p=Module["onRuntimeInitialized"];' +
    'Module["onRuntimeInitialized"]=function(){NvimIO.setup();if(_p){_p();}};})();',
  $NvimIO__deps: ['$FS'],
  $NvimIO: {
    dbg: function (m) {
      try {
        var p = process.env.NVIM_WASM_IO_LOG;
        if (p) { require('fs').appendFileSync(p, m + '\n'); }
      } catch (e) { /* ignore */ }
    },
    channel: null,        // RingChannel (engine: server side; client: client side)
    canBlockSync: false,  // engine (worker): true; client (main thread): false
    clientMode: false,    // client (main-thread TUI): true
    stdinQueue: [],       // buffered real-terminal input (client): [{buf,off}]
    stdinEnded: false,
    wake: null,           // wakes a pending async poll (client), set during a wait
    engineWorker: null,

    setup: function () {
      var ch = Module['nvimServerChannel'];
      if (!ch) {
        return;  // CLIENT setup happens later, in nvim_wasm_start_engine.
      }
      // ENGINE role.
      NvimIO.channel = ch;
      NvimIO.canBlockSync = !!Module['nvimCanBlockSync'];
      NvimIO.applyChannelOps(FS.getStream(0), ch, 'r');
      NvimIO.applyChannelOps(FS.getStream(1), ch, 'w');
    },

    // Install ring-channel stream ops on an existing FS stream. mode 'r' reads
    // ch.in; mode 'w' writes ch.out. We keep stream.tty set (callers ensure it):
    // isatty(fd) must stay true so libuv's uv_guess_handle() returns UV_TTY (the
    // pipe path) rather than UV_FILE (which would read the fd as a file and EOF).
    applyChannelOps: function (stream, ch, mode) {
      if (!stream) {
        return;
      }
      stream.seekable = false;
      var EAGAIN = 6;
      var POLLIN = 0x001, POLLOUT = 0x004;
      stream.stream_ops = {
        read: function (stream, buffer, offset, length /*, position */) {
          if (ch.in.available() === 0) {
            if (ch.in.isClosed()) {
              return 0;  // genuine EOF
            }
            throw new FS.ErrnoError(EAGAIN);
          }
          var u8 = new Uint8Array(buffer.buffer, buffer.byteOffset || 0);
          return ch.in.read(u8, offset, length);
        },
        write: function (stream, buffer, offset, length /*, position */) {
          var u8 = new Uint8Array(buffer.buffer, buffer.byteOffset || 0);
          var n = ch.out.write(u8, offset, length);
          if (n === 0) {
            throw new FS.ErrnoError(EAGAIN);
          }
          return n;
        },
        poll: function (/* stream, timeout */) {
          var mask = 0;
          if (mode === 'r' && (ch.in.available() > 0 || ch.in.isClosed())) {
            mask |= POLLIN;
          }
          if (mode === 'w' && ch.out.freeSpace() > 0) {
            mask |= POLLOUT;
          }
          return mask;
        },
        llseek: function () { throw new FS.ErrnoError(70); },
      };
    },

    // Create a fresh fd backed by the ring channel (client side). Open /dev/null
    // (a real char-device node with a valid .mode so the FS read/write wrappers
    // don't choke) then swap in channel ops and a tty marker (see applyChannelOps).
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
            // Copy out of the wasm heap: process.*.write is async and memory
            // growth can detach the underlying ArrayBuffer.
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

      // Make TIOCGWINSZ on the terminal fds report the real size. fd 0 and fd 1/2
      // use different default tty-ops objects, so patch each.
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
        if (NvimIO.wake) { NvimIO.wake(); }
      });
      process.stdin.on('end', function () {
        NvimIO.stdinEnded = true;
        if (NvimIO.wake) { NvimIO.wake(); }
      });
      process.stdin.resume();
      process.on('exit', function () {
        try { if (process.stdin.isTTY) { process.stdin.setRawMode(false); } } catch (e) { /* ignore */ }
      });
    },

    // CLIENT: async (non-blocking) wait used by __syscall_poll on the main
    // thread. Resolves when the channel ring or terminal stdin becomes readable,
    // or the libuv timeout elapses. We poll the ring on a short interval because
    // a single wait must cover three sources at once -- the channel ring, the
    // terminal stdin (a Node 'data' event, not a memory location), and the
    // timeout -- and the interval handles all of them plus channel-close
    // uniformly. (Atomics.waitAsync works fine here -- see sab.js -- and could
    // replace the ring part, but the closed-ring case would still need macrotask
    // pacing to avoid the os_hrtime freeze noted below; see stage3.md.)
    pollWaitAsync: function (timeout) {
      return new Promise(function (resolve) {
        var done = false;
        var prevWake = NvimIO.wake;
        function ready() {
          var ch = NvimIO.channel;
          return (ch && (ch.in.available() > 0 || ch.in.isClosed()))
              || NvimIO.stdinQueue.length > 0 || NvimIO.stdinEnded;
        }
        function finish() {
          if (done) { return; }
          done = true;
          if (timer) { clearTimeout(timer); }
          clearInterval(iv);
          NvimIO.wake = prevWake;
          resolve();
        }
        var timer = timeout > 0 ? setTimeout(finish, timeout) : null;
        NvimIO.wake = finish;  // woken immediately by the stdin 'data' handler
        // Poll the ring on a real (macrotask) interval. We deliberately do NOT
        // resolve synchronously here even if ready() is already true: once the
        // channel is closed, ready() stays true forever, and a synchronous
        // resolve would create a microtask-only tight loop that starves Node's
        // macrotask queue -- which both spins the CPU and freezes the wall-clock
        // timeouts the C event loop relies on (e.g. tui_stop's DA1 wait). Pacing
        // every wake through setInterval keeps time moving; stdin still wakes
        // instantly via NvimIO.wake.
        var iv = setInterval(function () { if (ready()) { finish(); } }, 3);
      });
    },
  },

  // C entry point (ui_client_start_server, wasm only): spawn the engine worker,
  // wire up the client side of the SAB channel + the real terminal, and hand the
  // client-side read/write fds back to C via *inFdPtr / *outFdPtr.
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
      var RingChannel = require(path.join(dir, 'sab.js')).RingChannel;
      var worker_threads = require('worker_threads');

      var CAP = 1 << 20;
      var made = RingChannel.create(CAP);
      var sab = made.sab;
      var client = new RingChannel(sab, CAP, 'client');
      NvimIO.channel = client;
      NvimIO.canBlockSync = false;
      NvimIO.clientMode = true;

      // The engine runs the same nvim args as this client (it opens the files).
      // Use the pristine copy: Module['arguments'] was mutated by callMain().
      var args = (Module['nvimUserArgs'] || Module['arguments'] || []).slice();
      var worker = new worker_threads.Worker(path.join(dir, 'worker.js'), {
        workerData: { sab: sab, cap: CAP, args: args },
        stdout: true, stderr: true,  // capture, don't let it corrupt the TUI
      });
      NvimIO.engineWorker = worker;

      // Drain the engine's stray stdout/stderr to an optional log file.
      var logPath = process.env.NVIM_WASM_ENGINE_LOG;
      var sink = null;
      if (logPath) { sink = require('fs').createWriteStream(logPath); }
      worker.stdout.on('data', function (d) { if (sink) { sink.write(d); } });
      worker.stderr.on('data', function (d) { if (sink) { sink.write(d); } });
      worker.on('error', function (e) { if (sink) { sink.write('worker error: ' + (e && e.stack || e) + '\n'); } });

      NvimIO.enableRawMode();
      NvimIO.installHostTerminal();

      var in_fd = NvimIO.makeChannelFd(client, 'r');
      var out_fd = NvimIO.makeChannelFd(client, 'w');
      NvimIO.dbg('nvim_wasm_start_engine: in_fd=' + in_fd + ' out_fd=' + out_fd);
      HEAP32[inFdPtr >> 2] = in_fd;
      HEAP32[outFdPtr >> 2] = out_fd;
    } catch (e) {
      fail(e);
    }
  },

  // Replacement for Emscripten's __syscall_poll. Computes fd readiness without
  // crashing on streams that lack a poll op, then waits when nothing is ready:
  //   * engine (off main thread): block synchronously via Atomics.wait.
  //   * client (main thread): suspend asynchronously via JSPI (no busy-spin).
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
          // Plain files have no poll op: report the requested r/w bits ready and
          // let the (blocking) read sort it out.
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
    var ch = NvimIO.channel;
    if (NvimIO.canBlockSync && ch) {
      // ENGINE: block the worker thread until the channel is readable.
      ch.in.waitReadable(timeout < 0 ? Infinity : timeout);
      return compute();
    }
    if (NvimIO.clientMode) {
      // CLIENT: suspend (JSPI) until stdin/channel readable or timeout.
      return NvimIO.pollWaitAsync(timeout).then(compute);
    }
    return ready;
  },
});
