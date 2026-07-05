// src/nvim/event/proxy_proc.c - Stage 4 / Phase 3 (seam 2): a child-process
// spawn backend that bypasses uv_spawn and runs the child on the IO-proxy
// SERVER, carrying its stdin/stdout/stderr over VIRTUAL pollable fds.
//
// ============================================================================
// WHY THIS EXISTS / WHAT IT REPLACES
// ============================================================================
// In the native build a child is spawned by libuv_proc_spawn() -> uv_spawn(),
// which gives a uv_process_t whose exit_cb drives proc->status + the close/
// refcount teardown in proc.c. Under Emscripten there is no fork/posix_spawn,
// so uv_spawn() fails (ENOSYS) and :!/system()/jobstart() are unavailable.
//
// When the engine worker is configured with an IO-proxy (globalThis.__nvimProxy,
// set by wasm/web/engine-worker.js / wasm/worker.js), this backend runs the
// child on the server instead and wires its three stdio streams into nvim's
// existing rstream/wstream layer using the de-risked mechanism from SPIKE B:
//
//   - allocate a VIRTUAL pollable fd per stdio stream (a MEMFS-backed fd with
//     queue-backed read/write/poll stream_ops + a `stream.tty` marker, so
//     uv_guess_handle() returns UV_TTY and uv_pipe_open(fd) accepts it -- see
//     wasm/nvim_proc_proxy.js, the productionization of SPIKE B / applyChannelOps);
//   - hand those fds to nvim's normal uv_pipe_init (done already in proc_spawn)
//     + uv_pipe_open(fd) path; stream_init() then wires them exactly as the
//     pre-existing-fd path libuv_proc.c uses;
//   - the server streams the child's stdout/stderr back as `proc.stdout`/
//     `proc.stderr` push frames -> JS enqueues into the out/err fd + wakes poll
//     -> nvim's read_cb fires. nvim writes to the stdin fd -> the write stream_op
//     -> a `proc.stdin` request -> the server writes to the child.
//
// ============================================================================
// LIFECYCLE (the hard part) -- a NEW ProcType, kProcTypeProxy
// ============================================================================
// Without a uv_process_t there is no exit_cb. We reproduce nvim's exit/close/
// refcount flow ourselves:
//   - proc_spawn() (in proc.c, EMSCRIPTEN-guarded) retargets a kProcTypeUv proc
//     to kProcTypeProxy when a proxy is active and calls proxy_proc_spawn();
//   - the server's child 'exit' is pushed to JS, which calls the
//     EMSCRIPTEN_KEEPALIVE entry nvim_proxy_proc_on_exit(handle, status, signal).
//     That sets proc->status (signal ? 128+signal : status, matching
//     libuv_proc.c:exit_cb) and calls proc->internal_exit_cb (== on_proc_exit),
//     which queues proc_close_handles() -> flushes the out/err streams, closes
//     all streams (EOF), proc_close() -> proxy_proc_close() (closes nothing uv,
//     just runs internal_close_cb == decref), and decref() fires proc->cb
//     (channel job exit) once refcount hits zero.
//   - proxy_proc_close() must NOT touch any uv_process_t (there is none); it just
//     invokes proc->internal_close_cb(proc), the same effect close_cb has in
//     libuv_proc.c.
//
// ============================================================================
// NO ProxyProc STRUCT
// ============================================================================
// The embedding allocation is a LibuvProc (channel.c/shell.c), which has NO room
// for proxy-specific fields. So we keep ZERO extra state in C: the server child
// id + the three virtual fds live in JS (wasm/nvim_proc_proxy.js), keyed by the
// Proc* handle. The backend only ever touches the generic Proc.
//
// ============================================================================
// HARD INVARIANTS
// ============================================================================
// The WHOLE file is compiled only under __EMSCRIPTEN__. proc.c only ever creates
// a kProcTypeProxy proc when a proxy is active (nvim_proxy_active() != 0), so a
// wasm build WITHOUT a proxy never takes this path -- spawning fails exactly as
// it does today. The native build never sees kProcTypeProxy at all.
#ifdef __EMSCRIPTEN__

# include <emscripten.h>
# include <stddef.h>
# include <string.h>
# include <uv.h>

# include "nvim/event/proc.h"
# include "nvim/event/proxy_proc.h"
# include "nvim/eval/typval.h"
# include "nvim/memory.h"
# include "nvim/os/os.h"

// ---------------------------------------------------------------------------
// JS bridge (implemented in wasm/nvim_proc_proxy.js). proc.c gates the whole
// backend on nvim_proxy_active(), so these are only ever called with a live
// proxy.
// ---------------------------------------------------------------------------

// Returns nonzero iff globalThis.__nvimProxy is present (a proxy is configured).
extern int nvim_proxy_active(void);

// Allocate a virtual pollable fd. mode 0 = readable (child stdout/stderr),
// mode 1 = writable (child stdin). Returns the fd (>= 0) or -1 on failure.
extern int nvim_proxy_alloc_fd(int mode);

// Request `proc.spawn` from the server (argv/env are NUL-separated, see below)
// and register the proc handle so stdout/stderr/exit pushes route to it. Returns
// the server child id (>= 0) on success, or a negative value on failure.
//   handle        : the Proc* (an opaque token the exit push echoes back)
//   argv          : NUL-separated, double-NUL-terminated argv (argv[0] is exepath)
//   cwd           : working directory ("" = server default)
//   env           : NUL-separated, double-NUL-terminated KEY=VAL list ("" = inherit)
//   fd_in/out/err : the virtual fds (or -1 when that stream is not wanted)
extern int nvim_proxy_proc_spawn(void *handle, const char *argv, const char *cwd,
                                 const char *env, int fd_in, int fd_out, int fd_err);

// Tear down the JS-side bookkeeping for `handle` (fd queues, child id map).
// Called from the close path so a late push is dropped.
extern void nvim_proxy_proc_release(void *handle);

// ---------------------------------------------------------------------------
// argv/env flattening: NUL-separated, double-NUL-terminated. JS reads the whole
// buffer and splits on the embedded NULs (it stops at the empty trailing
// string). This avoids any JSON escaping in C and round-trips arbitrary bytes
// (argv/env can't contain an embedded NUL anyway).
// ---------------------------------------------------------------------------
static char *flatten_strv(char **strv, size_t *out_len)
{
  size_t total = 1;  // for the final extra NUL (double-NUL terminator)
  if (strv) {
    for (size_t i = 0; strv[i] != NULL; i++) {
      total += strlen(strv[i]) + 1;
    }
  }
  char *buf = xmalloc(total);
  size_t off = 0;
  if (strv) {
    for (size_t i = 0; strv[i] != NULL; i++) {
      size_t n = strlen(strv[i]);
      memcpy(buf + off, strv[i], n);
      off += n;
      buf[off++] = '\0';
    }
  }
  buf[off++] = '\0';  // double-NUL terminator (empty trailing string)
  *out_len = off;
  return buf;
}

/// Spawn a process on the IO-proxy server. Mirrors libuv_proc_spawn()'s contract:
/// returns 0 on success (with proc->pid set), or a negative error code.
///
/// proc->in/out/err pipes were already uv_pipe_init()'d by proc_spawn(); here we
/// allocate the virtual fds and uv_pipe_open() them, then ask the server to run
/// the child wired to those fds. stream_init() happens back in proc_spawn() after
/// we return, exactly as for the uv backend.
int proxy_proc_spawn(Proc *proc)
{
  int fd_in = -1;
  int fd_out = -1;
  int fd_err = -1;

  // Allocate + wrap the virtual stdio fds for the streams nvim wants. A stream
  // is wanted iff !closed (the flags were set by proc_spawn()).
  if (!proc->in.closed) {
    fd_in = nvim_proxy_alloc_fd(1 /* writable: nvim writes child stdin */);
    if (fd_in < 0) {
      return UV_ENOMEM;
    }
    uv_pipe_open(&proc->in.uv.pipe, fd_in);
  }
  if (!proc->out.s.closed) {
    fd_out = nvim_proxy_alloc_fd(0 /* readable: child stdout -> nvim */);
    if (fd_out < 0) {
      return UV_ENOMEM;
    }
    uv_pipe_open(&proc->out.s.uv.pipe, fd_out);
  }
  if (!proc->err.s.closed) {
    fd_err = nvim_proxy_alloc_fd(0 /* readable: child stderr -> nvim */);
    if (fd_err < 0) {
      return UV_ENOMEM;
    }
    uv_pipe_open(&proc->err.s.uv.pipe, fd_err);
  }

  size_t argv_len = 0;
  char *argv_buf = flatten_strv(proc->argv, &argv_len);

  char **fullenv = NULL;
  size_t env_len = 0;
  char *env_buf;
  if (proc->env) {
    fullenv = tv_dict_to_env(proc->env);
    env_buf = flatten_strv(fullenv, &env_len);
  } else {
    env_buf = flatten_strv(NULL, &env_len);
  }

  const char *cwd = proc->cwd ? proc->cwd : "";

  int child_id = nvim_proxy_proc_spawn(proc, argv_buf, cwd, env_buf,
                                       fd_in, fd_out, fd_err);

  xfree(argv_buf);
  xfree(env_buf);
  if (fullenv) {
    os_free_fullenv(fullenv);
  }

  if (child_id < 0) {
    return UV_ENOENT;
  }

  // Use the server child id as the pid: positive, unique per child, treated as an
  // opaque identifier by proc_stop()/jobpid().
  proc->pid = child_id;
  return 0;
}

/// Close path for a proxy proc. There is NO uv_process_t to uv_close(), so we
/// just run the internal_close_cb (== decref) the way libuv_proc.c's close_cb
/// does, after dropping the JS-side bookkeeping.
void proxy_proc_close(Proc *proc)
{
  nvim_proxy_proc_release(proc);
  if (proc->internal_close_cb) {
    proc->internal_close_cb(proc);
  }
}

/// EMSCRIPTEN_KEEPALIVE exit entry: wasm/nvim_proc_proxy.js calls this (via
/// Module.ccall / _nvim_proxy_proc_on_exit) when the server pushes `proc.exit`.
/// It reproduces libuv_proc.c's exit_cb: set proc->status from the child's real
/// exit code/signal, then run proc->internal_exit_cb (== on_proc_exit), which
/// drives the close/refcount/proc->cb flow on the main loop.
///
/// `handle` is the Proc* we handed nvim_proxy_proc_spawn(). It never leaves this
/// realm (JS stores it opaquely and echoes it back); a released handle is dropped
/// JS-side before this could fire on a freed proc.
EMSCRIPTEN_KEEPALIVE
void nvim_proxy_proc_on_exit(void *handle, int status, int signal)
{
  Proc *proc = (Proc *)handle;
  if (proc == NULL) {
    return;
  }
  // libuv encodes a signalled exit as 128 + signal; mirror that exactly.
  proc->status = signal ? (128 + signal) : status;
  if (proc->internal_exit_cb) {
    proc->internal_exit_cb(proc);
  }
}

#endif  // __EMSCRIPTEN__
