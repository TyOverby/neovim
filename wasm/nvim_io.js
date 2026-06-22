// wasm/nvim_io.js - Emscripten JS-library glue for Neovim's wasm build.
//
// Integrates Neovim's libuv event loop with Node/JSPI, and (for the server
// role) backs the RPC stdin/stdout with a SharedArrayBuffer ring channel so the
// server and UI client can run as separate processes/threads communicating over
// shared memory.
//
// Roles:
//   * SERVER (e.g. an `nvim --embed` running in a worker_thread): the JS host
//     sets Module.nvimServerChannel to a RingChannel (see wasm/sab.js) before
//     boot. We replace fd 0/1's stream ops with ops that read/write that
//     channel, and block in poll() via Atomics.wait. No real pipes involved.
//   * Plain run (headless / -l / pipe-connected --embed): no channel; poll()
//     just reports fd readiness without crashing (Emscripten's stock poll()
//     dereferences an undefined stream_ops.poll under NODERAWFS).
//
// poll(2) bits: POLLIN 0x001  POLLOUT 0x004  POLLERR 0x008  POLLHUP 0x010  POLLNVAL 0x020
// errno: EAGAIN 6

addToLibrary({
  $NvimIO__postset:
    'Module["preRun"]=(Module["preRun"]||[]);' +
    'Module["preRun"].push(function(){NvimIO.setup();});',
  $NvimIO__deps: ['$FS'],
  $NvimIO: {
    channel: null,        // RingChannel for the RPC stream, if server role
    canBlockSync: false,  // true off the main thread (Atomics.wait allowed)

    setup: function () {
      var ch = Module['nvimServerChannel'];
      if (!ch) {
        return;
      }
      NvimIO.channel = ch;
      // Atomics.wait is only allowed off the main thread. In a worker_thread it
      // is; the host sets Module.nvimCanBlockSync accordingly.
      NvimIO.canBlockSync = !!Module['nvimCanBlockSync'];
      NvimIO.installChannelStream(0, 'r');
      NvimIO.installChannelStream(1, 'w');
    },

    // Replace fd's stream ops with ring-channel ops. mode 'r' => read side
    // (ch.in), 'w' => write side (ch.out).
    installChannelStream: function (fd, mode) {
      var ch = NvimIO.channel;
      var stream = FS.getStream(fd);
      if (!stream) {
        return;
      }
      stream.tty = undefined;  // don't take the tty path
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
          // `buffer` is HEAP8 over the wasm memory; offset is the byte offset.
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
        llseek: function () { throw new FS.ErrnoError(70); },  // ESPIPE
      };
    },
  },

  // Replacement for Emscripten's __syscall_poll. Computes fd readiness without
  // crashing on streams that lack a poll op, and blocks (Atomics.wait on the
  // channel) when nothing is ready yet and a timeout was requested.
  __syscall_poll__deps: ['$FS', '$NvimIO'],
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
          // Channel streams report real readiness from the ring buffer.
          revents = stream.stream_ops.poll(stream, -1) & events;
        } else {
          // Plain pipes/ttys/files under NODERAWFS have no poll op. Report the
          // requested readable/writable bits ready and let the (blocking) read
          // sort it out. This is what an `nvim --embed` server connected over
          // real pipes relies on.
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
    // Block until the channel becomes readable or the timeout elapses.
    var ch = NvimIO.channel;
    if (ch && NvimIO.canBlockSync) {
      ch.in.waitReadable(timeout < 0 ? Infinity : timeout);
      return compute();
    }
    return ready;  // (main-thread async path handled separately; TODO)
  },
});
