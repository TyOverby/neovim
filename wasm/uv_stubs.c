// wasm/uv_stubs.c - libuv functions missing from the Emscripten build.
//
// libuv's Emscripten/wasm target omits its Linux-specific source file
// (src/unix/linux.c) and the inotify-based fs-event backend, so a handful of
// public libuv symbols end up undefined at link time. They are referenced both
// by Neovim core and by luv (vim.uv). We provide conservative implementations
// here. This file is linked into nvim_bin ONLY for the Emscripten build (see
// src/nvim/CMakeLists.txt, guarded by `if(EMSCRIPTEN)`), so native builds use
// the real libuv implementations.
//
// Design notes:
//   * System-info queries (memory/loadavg/uptime/cpu) return benign constants
//     or UV_ENOSYS. Neovim only uses these for option defaults and `vim.uv`
//     introspection; none are load-bearing for editing.
//   * Filesystem watching (uv_fs_event_*) returns UV_ENOSYS, mirroring libuv's
//     own src/unix/no-fsevents.c. Callers (autoread, vim.uv.new_fs_event) treat
//     ENOSYS as "watching unsupported" and degrade gracefully.

#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <uv.h>

// --- executable path -------------------------------------------------------
// Neovim calls uv_exepath() to locate $VIMRUNTIME relative to the binary. In
// the wasm runtime there is no real executable path; the launcher sets
// $VIMRUNTIME explicitly, so this only needs to be non-fatal. We report a
// stable, plausible path.
int uv_exepath(char *buffer, size_t *size)
{
  static const char path[] = "/usr/bin/nvim";
  if (buffer == NULL || size == NULL || *size == 0) {
    return UV_EINVAL;
  }
  size_t n = sizeof(path) - 1;
  if (n >= *size) {
    n = *size - 1;
  }
  memcpy(buffer, path, n);
  buffer[n] = '\0';
  *size = n;
  return 0;
}

// --- system info -----------------------------------------------------------
int uv_uptime(double *uptime)
{
  if (uptime != NULL) {
    *uptime = 0.0;
  }
  return 0;
}

void uv_loadavg(double avg[3])
{
  avg[0] = avg[1] = avg[2] = 0.0;
}

uint64_t uv_get_total_memory(void)
{
  return (uint64_t)2 * 1024 * 1024 * 1024;  // 2 GiB
}

uint64_t uv_get_free_memory(void)
{
  return (uint64_t)1 * 1024 * 1024 * 1024;  // 1 GiB
}

uint64_t uv_get_constrained_memory(void)
{
  return 0;  // "no limit known"
}

uint64_t uv_get_available_memory(void)
{
  return (uint64_t)1 * 1024 * 1024 * 1024;  // 1 GiB
}

int uv_resident_set_memory(size_t *rss)
{
  if (rss != NULL) {
    *rss = 0;
  }
  return 0;
}

int uv_cpu_info(uv_cpu_info_t **cpu_infos, int *count)
{
  *cpu_infos = NULL;
  *count = 0;
  return UV_ENOSYS;
}

int uv_interface_addresses(uv_interface_address_t **addresses, int *count)
{
  *addresses = NULL;
  *count = 0;
  return UV_ENOSYS;
}

// Note: uv_{get,set}_process_title and uv_fs_event_{init,start,stop} are NOT
// stubbed here: the Emscripten libuv build (patched via
// PatchLibuvEmscripten.cmake) pulls in libuv's own src/unix/no-proctitle.c and
// src/unix/no-fsevents.c, which provide portable no-op implementations.

// --- libc scheduling gaps --------------------------------------------------
// libuv's src/unix/thread.c references these POSIX scheduling functions (for
// uv_thread_create thread priorities). Emscripten *declares* them in
// <pthread.h>/<sched.h> but its libc provides no implementation, so they are
// undefined when linking the prebuilt libuv.a into nvim. Neovim never creates
// prioritized threads in the wasm runtime, so trivial stubs suffice.
#include <pthread.h>
#include <sched.h>

// libuv's thread.c (compiled with _GNU_SOURCE in our Emscripten branch) calls
// pthread_setname_np()/pthread_getname_np(). Emscripten declares them under
// _GNU_SOURCE but its libc has no implementation, so they're undefined when the
// prebuilt libuv.a is linked. Thread names are meaningless in the wasm runtime.
// (wasm/shim.h only stubs these for translation units compiled WITHOUT
// _GNU_SOURCE; this file is compiled WITH it, matching the real prototype.)
int pthread_setname_np(pthread_t thread, const char *name)
{
  (void)thread;
  (void)name;
  return 0;
}

int pthread_getname_np(pthread_t thread, char *name, size_t len)
{
  (void)thread;
  if (name != NULL && len > 0) {
    name[0] = '\0';
  }
  return 0;
}

int sched_get_priority_max(int policy)
{
  (void)policy;
  return 0;
}

int sched_get_priority_min(int policy)
{
  (void)policy;
  return 0;
}

int pthread_setschedparam(pthread_t thread, int policy,
                          const struct sched_param *param)
{
  (void)thread;
  (void)policy;
  (void)param;
  return 0;
}

// ===========================================================================
// Stage 4 / Phase 4 (additive, opt-in): proxy uv_spawn at the LIBUV layer.
// ===========================================================================
// Phase 3 proxied nvim's own Proc layer (proc_spawn -> kProcTypeProxy), which
// covers jobstart()/:!/system(). But nvim's LSP client and vim.system() do NOT
// go through that path: vim.lsp.rpc -> vim.system() -> uv.spawn() (luv) ->
// uv_spawn() directly, which is ENOSYS in wasm and bypasses the Phase 3 proxy.
//
// We intercept uv_spawn (and uv_process_kill) with the wasm linker's
// --wrap=uv_spawn / --wrap=uv_process_kill (set wasm-only in
// src/nvim/CMakeLists.txt). The real implementations remain reachable as
// __real_uv_spawn / __real_uv_process_kill.
//
//   __wrap_uv_spawn(loop, handle, options):
//     - if NO proxy is active -> return __real_uv_spawn(...)  (ENOSYS, as today);
//     - else run the child on the IO-proxy SERVER, carrying its stdio over the
//       SAME virtual pollable fds + server protocol that Phase 3 uses (the JS
//       half is wasm/nvim_proc_proxy.js, extended with uv_spawn-specific entries).
//
// The hard part is the uv_process_t lifecycle. luv allocates `handle`, then after
// a successful spawn uses it for uv_process_kill(handle,sig), the exit callback
// options->exit_cb(handle, exit_status, term_signal), and finally
// uv_close((uv_handle_t*)handle, cb). Since we bypass the real spawn, we must make
// `handle` a valid, loop-registered UV_PROCESS handle so uv_close tears it down
// cleanly (uv__process_close does uv__queue_remove(&handle->queue) +
// uv__handle_stop). We replicate EXACTLY the handle bookkeeping real uv_spawn
// performs (uv__handle_init + queue init/insert + status/pid/exit_cb +
// uv__handle_start), proven safe by the throwaway SPIKE C. This is gated entirely
// behind __EMSCRIPTEN__, so the native build keeps the real libuv uv_spawn.
#ifdef __EMSCRIPTEN__

# include <emscripten.h>
# include <stdlib.h>

// The INTERNAL libuv header (scoped to THIS translation unit via a
// target_include_directories addition in src/nvim/CMakeLists.txt) gives us the
// uv__handle_init / uv__handle_start / uv__handle_stop / uv__queue_* machinery
// that real uv_spawn uses. These are pure macros over struct fields (no external
// libuv functions), so including it here does not pull in extra symbols.
# include "uv-common.h"

// The real libuv functions (renamed by --wrap). Declared so we can fall through
// to them when no proxy is configured.
int __real_uv_spawn(uv_loop_t *loop, uv_process_t *handle,
                    const uv_process_options_t *options);
int __real_uv_process_kill(uv_process_t *process, int signum);

// JS bridge for uv-spawn children (wasm/nvim_proc_proxy.js). These are DISTINCT
// from the Phase 3 Proc entries (nvim_proxy_proc_spawn etc.) because a uv-spawn
// child drives uv_spawn's own exit_cb / uv_close lifecycle, not nvim's Proc one.
extern int nvim_proxy_active(void);
extern int nvim_proxy_alloc_fd(int mode);  // 0=readable, 1=writable; shared w/ Phase 3
// Register a uv-spawn child: returns a server-bound child id (>= 0) or -1.
//   handle        : the uv_process_t* (echoed back by the exit push)
//   argv          : NUL-separated, double-NUL-terminated argv
//   cwd           : working directory ("" = server default)
//   env           : NUL-separated, double-NUL-terminated KEY=VAL list ("" = inherit)
//   fd_in/out/err : the virtual fds (or -1 when that stream is UV_IGNORE/UV_INHERIT)
extern int nvim_uv_proxy_spawn(void *handle, const char *argv, const char *cwd,
                               const char *env, int fd_in, int fd_out, int fd_err);
extern void nvim_uv_proxy_kill(void *handle, int signum);
extern void nvim_uv_proxy_release(void *handle);

// Flatten a NULL-terminated string array into a NUL-separated,
// double-NUL-terminated buffer (JS splits on the NULs). Same shape as
// flatten_strv() in proxy_proc.c; duplicated here to keep this TU self-contained.
static char *uv_proxy_flatten(char **strv, size_t *out_len)
{
  size_t total = 1;  // trailing extra NUL (double-NUL terminator)
  if (strv != NULL) {
    for (size_t i = 0; strv[i] != NULL; i++) {
      total += strlen(strv[i]) + 1;
    }
  }
  char *buf = malloc(total);
  if (buf == NULL) {
    *out_len = 0;
    return NULL;
  }
  size_t off = 0;
  if (strv != NULL) {
    for (size_t i = 0; strv[i] != NULL; i++) {
      size_t n = strlen(strv[i]);
      memcpy(buf + off, strv[i], n);
      off += n;
      buf[off++] = '\0';
    }
  }
  buf[off++] = '\0';
  *out_len = off;
  return buf;
}

// EMSCRIPTEN_KEEPALIVE exit entry for uv-spawn children. wasm/nvim_proc_proxy.js
// calls this (via Module.ccall) when the server pushes `proc.exit` for a child
// that was registered by nvim_uv_proxy_spawn. It drives uv_spawn's own exit_cb
// and the handle teardown -- DISTINCT from Phase 3's nvim_proxy_proc_on_exit,
// which drives nvim's Proc exit.
//
// luv's exit_cb (process.c) then schedules uv_close((uv_handle_t*)handle, ...);
// uv__process_close runs uv__queue_remove(&handle->queue) + uv__handle_stop on
// the handle we initialized in __wrap_uv_spawn, so the teardown is clean.
EMSCRIPTEN_KEEPALIVE
void nvim_uv_proxy_on_exit(uv_process_t *handle, int status, int signal)
{
  if (handle == NULL) {
    return;
  }
  handle->status = status;
  if (handle->exit_cb != NULL) {
    // libuv passes exit_status (the raw exit code) and term_signal separately.
    handle->exit_cb(handle, (int64_t)status, signal);
  }
}

// __wrap_uv_spawn: the linker redirects every uv_spawn call here.
int __wrap_uv_spawn(uv_loop_t *loop, uv_process_t *handle,
                    const uv_process_options_t *options)
{
  // No proxy configured -> behave EXACTLY as today (the real uv_spawn, ENOSYS in
  // wasm). This keeps the wasm-without-proxy build byte-for-byte unchanged.
  if (!nvim_proxy_active()) {
    return __real_uv_spawn(loop, handle, options);
  }

  int fd_in = -1;
  int fd_out = -1;
  int fd_err = -1;

  // Wire each stdio container. luv (and vim.system) use UV_CREATE_PIPE with
  // data.stream pointing at a uv_pipe_t the caller already uv_pipe_init'd but did
  // NOT open. We allocate a virtual pollable fd and uv_pipe_open() the caller's
  // stream onto it -- the de-risked SPIKE B path. A container's direction comes
  // from the pipe flags luv sets: UV_READABLE_PIPE means the CHILD reads it (i.e.
  // child stdin -> nvim WRITES -> fd mode 1); UV_WRITABLE_PIPE means the child
  // writes it (child stdout/stderr -> nvim READS -> fd mode 0). UV_INHERIT_FD /
  // UV_INHERIT_STREAM / UV_IGNORE containers get no virtual fd (left unwired).
  for (int i = 0; i < options->stdio_count; i++) {
    const uv_stdio_container_t *c = &options->stdio[i];
    if (!(c->flags & UV_CREATE_PIPE)) {
      continue;  // UV_IGNORE / UV_INHERIT_FD / UV_INHERIT_STREAM: nothing to wire
    }
    uv_pipe_t *pipe = (uv_pipe_t *)c->data.stream;
    if (pipe == NULL) {
      continue;
    }
    // A pipe the child reads from is its stdin (nvim writes it): mode 1 (writable
    // for nvim). A pipe the child writes to is stdout/stderr (nvim reads): mode 0.
    int child_reads = (c->flags & UV_READABLE_PIPE) != 0;
    int fd = nvim_proxy_alloc_fd(child_reads ? 1 : 0);
    if (fd < 0) {
      return UV_ENOMEM;
    }
    uv_pipe_open(pipe, fd);
    // Map by conventional slot: 0=stdin, 1=stdout, 2=stderr. (LSP and vim.system
    // both use exactly this 3-pipe layout.)
    if (i == 0) {
      fd_in = fd;
    } else if (i == 1) {
      fd_out = fd;
    } else if (i == 2) {
      fd_err = fd;
    }
    // stdio beyond index 2 is unusual for our callers; if it appears, the fd is
    // still allocated + opened (so the stream is valid) but not routed to the
    // server's 3 standard streams. LSP/vim.system never hit this.
  }

  // Flatten argv (options->args is NULL-terminated, args[0] == file).
  size_t argv_len = 0;
  char *argv_buf = uv_proxy_flatten(options->args, &argv_len);

  // Flatten env (options->env is NULL-terminated, or NULL == inherit).
  size_t env_len = 0;
  char *env_buf = uv_proxy_flatten(options->env, &env_len);

  const char *cwd = options->cwd ? options->cwd : "";

  int child_id = nvim_uv_proxy_spawn(handle, argv_buf ? argv_buf : "",
                                     cwd, env_buf ? env_buf : "",
                                     fd_in, fd_out, fd_err);
  free(argv_buf);
  free(env_buf);

  if (child_id < 0) {
    // Mirror real uv_spawn's failure contract: return a negative error WITHOUT
    // having activated the handle. luv then uv_close()'s the (still type=PROCESS,
    // but luv sets handle->type itself) handle. We did NOT uv__handle_init it, so
    // it is not loop-registered; but luv always uv_close()'s on failure, and
    // uv__process_close on an un-init'd handle would touch handle->queue. To stay
    // safe, init the handle minimally so the close path is well-formed even on
    // the failure branch.
    uv__handle_init(loop, (uv_handle_t *)handle, UV_PROCESS);
    uv__queue_init(&handle->queue);
    handle->status = 0;
    handle->pid = 0;
    handle->exit_cb = options->exit_cb;
    return UV_ENOENT;
  }

  // SUCCESS: replicate uv_spawn's handle bookkeeping so kill/exit/close all work
  // on this handle (proven safe by SPIKE C). Order matches real uv_spawn.
  uv__handle_init(loop, (uv_handle_t *)handle, UV_PROCESS);
  uv__queue_init(&handle->queue);
  handle->status = 0;
  handle->pid = child_id;             // server child id, used as the pid
  handle->exit_cb = options->exit_cb;
  uv__queue_insert_tail(&loop->process_handles, &handle->queue);
  uv__handle_start(handle);
  return 0;
}

// __wrap_uv_process_kill: route a kill to the proxy server when the handle is one
// of ours (a proxied child). A real uv_process_kill would kill(handle->pid) on a
// server-side id, which is meaningless locally -- so we always handle proxied
// children here. If no proxy is active, fall through to the real implementation.
int __wrap_uv_process_kill(uv_process_t *process, int signum)
{
  if (!nvim_proxy_active()) {
    return __real_uv_process_kill(process, signum);
  }
  // nvim_uv_proxy_kill is a no-op for an unknown handle, so a handle that was
  // (somehow) not one of ours is simply not signalled rather than mis-killed.
  nvim_uv_proxy_kill(process, signum);
  return 0;
}

#endif  // __EMSCRIPTEN__
