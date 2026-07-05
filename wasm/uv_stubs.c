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

// ===========================================================================
// Stage 4 / TCP socket proxy (additive, opt-in): proxy outbound TCP + DNS.
// ===========================================================================
// nvim's TCP (src/nvim/event/socket.c: uv_getaddrinfo SYNC -> uv_tcp_connect ->
// connect_cb -> uv_read_start/uv_write) AND luv/vim.uv (ASYNC getaddrinfo + the
// same connect/read/write) both funnel through libuv uv_tcp_connect +
// uv_getaddrinfo. We intercept all three with the wasm linker's
//   -Wl,--wrap=uv_tcp_connect / --wrap=uv_getaddrinfo / --wrap=uv_freeaddrinfo
// (set wasm-only in src/nvim/CMakeLists.txt). UNIX-domain sockets
// (sockconnect('pipe', path) + vim.uv.new_pipe():connect / pipe_connect2) go
// through uv_pipe_connect / uv_pipe_connect2, wrapped too -- they reuse the whole
// TCP machinery, just connecting by PATH instead of host:port (no getaddrinfo).
// The real implementations remain reachable as __real_uv_*; the wraps fall
// through to them when no proxy is active, so the no-proxy build is byte-for-byte
// unchanged.
//
// The uv_tcp_t's bytes are carried over the SAME MEMFS-backed virtual pollable
// fd the spawn-stdio proxy uses (nvim_proxy_alloc_fd): uv_tcp_open(handle, fd)
// accepts it (de-risked by SPIKE S1 -- no real socket / no socketpair). The JS
// half is wasm/nvim_sock_proxy.js (a sibling --js-library), which speaks the
// sock.* protocol over globalThis.__nvimProxy and routes server pushes.
//
// This mirrors the shipped __wrap_uv_spawn EXACTLY: --wrap + handle/req init +
// fire-the-libuv-cb-on-a-server-event KEEPALIVE entry. The only new bookkeeping
// vs. the spawn wrap is uv__req_init / uv__req_unregister for the connect req
// (proven by SPIKE S2) and a synthesized heap addrinfo owned by the freeaddrinfo
// wrap (SPIKE S3). All gated behind __EMSCRIPTEN__.

# include <arpa/inet.h>
# include <netinet/in.h>
# include <netdb.h>
# include <stdint.h>

// The real libuv functions (renamed by --wrap). Declared so we can fall through
// to them when no proxy is configured.
int __real_uv_tcp_connect(uv_connect_t *req, uv_tcp_t *handle,
                          const struct sockaddr *addr, uv_connect_cb cb);
int __real_uv_getaddrinfo(uv_loop_t *loop, uv_getaddrinfo_t *req,
                          uv_getaddrinfo_cb cb, const char *node,
                          const char *service, const struct addrinfo *hints);
void __real_uv_freeaddrinfo(struct addrinfo *ai);
// Unix-domain (pipe) connect: the void form (socket.c + luv vim.uv.new_pipe()
// :connect) and the int form (luv pipe_connect2). Both connect by PATH.
void __real_uv_pipe_connect(uv_connect_t *req, uv_pipe_t *handle,
                            const char *name, uv_connect_cb cb);
int __real_uv_pipe_connect2(uv_connect_t *req, uv_pipe_t *handle,
                            const char *name, size_t namelen,
                            unsigned int flags, uv_connect_cb cb);
// Inbound listen/accept: bind/listen/accept/getsockname. We don't bind for real;
// the bind wraps STORE the addr, listen round-trips the server to net.createServer,
// accept pops a server-side connection onto a virtual fd. getsockname reports the
// REAL bound port (for serverstart('host:0') random binds + v:servername).
int __real_uv_tcp_bind(uv_tcp_t *handle, const struct sockaddr *addr,
                       unsigned int flags);
int __real_uv_pipe_bind(uv_pipe_t *handle, const char *name);
int __real_uv_listen(uv_stream_t *stream, int backlog, uv_connection_cb cb);
int __real_uv_accept(uv_stream_t *server, uv_stream_t *client);
int __real_uv_tcp_getsockname(const uv_tcp_t *handle, struct sockaddr *name,
                              int *namelen);
void __real_uv_close(uv_handle_t *handle, uv_close_cb close_cb);

// JS bridge for proxied sockets / DNS (wasm/nvim_sock_proxy.js).
//   nvim_sock_alloc_fd()      : a bidirectional virtual pollable fd (read = server
//                               sock.data; write -> server sock.write). Returns
//                               the fd or -1.
//   nvim_sock_connect(req, handle, fd, host, port):
//                               register the connect, fire sock.connect{host,port}
//                               async. The server's reply -> nvim_sock_on_connect.
//   nvim_sock_register_async(req, host, service):
//                               register an ASYNC getaddrinfo req; the server's
//                               reply -> nvim_sock_on_addrinfo_queued.
//   nvim_sock_resolve_sync(host, service) [__async]:
//                               round-trip sock.getaddrinfo and SUSPEND via JSPI;
//                               the result port is read back via
//                               nvim_sock_take_sync_port().
extern int nvim_proxy_active(void);
extern int nvim_sock_alloc_fd(void);
extern void nvim_sock_connect(void *req, void *handle, int fd,
                              const char *host, int port);
//   nvim_sock_connect_unix(req, handle, fd, path):
//                               register the connect, fire sock.connect{path}
//                               async (a UNIX-domain socket). The server's reply
//                               -> nvim_sock_on_connect, exactly like TCP.
extern void nvim_sock_connect_unix(void *req, void *handle, int fd,
                                   const char *path);
extern void nvim_sock_close_fd(int fd);
extern void nvim_sock_register_async(void *req, const char *host,
                                     const char *service);
extern void nvim_sock_resolve_sync(const char *host, const char *service);
extern int nvim_sock_take_sync_port(void);
extern int nvim_sock_take_sync_status(void);
// Inbound listen/accept JS bridge (wasm/nvim_sock_proxy.js).
//   nvim_sock_listen_sync(handle, host, port, path, isUnix) [__async]:
//       round-trip sock.listen and SUSPEND via JSPI. Registers the listener under
//       `handle` so sock.incoming pushes find it + the connection_cb. The result
//       (status + real bound port) is read back via nvim_sock_take_sync_status /
//       _port (reused from getaddrinfo).
//   nvim_sock_accept_next(handle, fd) -> 1 if a pending connection was popped
//       onto `fd` (server told to start streaming), 0 if none pending.
//   nvim_sock_set_conn_cb(handle): record that `handle` now has a connection_cb
//       (set in __wrap_uv_listen) so the drain knows where to route sock.incoming.
//   nvim_sock_listen_close(handle): close the server-side listener + drop it.
extern void nvim_sock_listen_sync(void *handle, const char *host, int port,
                                  const char *path, int isUnix);
extern int nvim_sock_take_listen_status(void);  // category: 0 ok, <0 error
extern int nvim_sock_take_listen_port(void);
extern int nvim_sock_accept_next(void *handle, int fd);
extern void nvim_sock_listen_close(void *handle);

// We tag our synthesized addrinfo so __wrap_uv_freeaddrinfo knows it is ours (a
// real getaddrinfo result would NOT carry this sentinel in ai_canonname). Same
// approach as SPIKE S3.
static const char SOCK_AI_SENTINEL[] = "NVIM_PROXY_AI";

// Build a one-entry heap struct addrinfo carrying a sockaddr_in (port from
// `service`, a loopback placeholder IP -- __wrap_uv_tcp_connect ignores the IP
// and routes by host:port, so a placeholder is fine). Tagged so our
// freeaddrinfo frees it. `host` is unused in the addr itself (the host string is
// carried separately to the server by the connect wrap).
static struct addrinfo *sock_synth_addrinfo(const char *service)
{
  struct addrinfo *ai = calloc(1, sizeof(struct addrinfo));
  struct sockaddr_in *sa = calloc(1, sizeof(struct sockaddr_in));
  if (ai == NULL || sa == NULL) {
    free(ai);
    free(sa);
    return NULL;
  }
  int port = service ? atoi(service) : 0;
  sa->sin_family = AF_INET;
  sa->sin_port = htons((uint16_t)port);
  inet_pton(AF_INET, "127.0.0.1", &sa->sin_addr);
  ai->ai_family = AF_INET;
  ai->ai_socktype = SOCK_STREAM;
  ai->ai_protocol = IPPROTO_TCP;
  ai->ai_addrlen = sizeof(struct sockaddr_in);
  ai->ai_addr = (struct sockaddr *)sa;
  ai->ai_canonname = (char *)SOCK_AI_SENTINEL;  // sentinel (not freed)
  ai->ai_next = NULL;
  return ai;
}

// --- getaddrinfo ASYNC bookkeeping -----------------------------------------
// For the ASYNC form (luv), the caller's req carries the cb; we stash the port
// the server resolves so the KEEPALIVE entry can build the addrinfo + fire cb.
// We key by req pointer through a tiny fixed table (luv issues these one at a
// time in practice; a small ring is plenty and avoids a malloc'd map).

// --- deferred-callback queue + drain --------------------------------------
// CRITICAL JSPI CONSTRAINT: the libuv callbacks we fire (a connect_cb / luv's
// getaddrinfo cb) run nvim code that re-enters the event loop and can hit the
// JSPI-suspending __syscall_poll. They MUST therefore run on the engine's MAIN
// stack, which is already inside a `promising` frame (suspended in poll). If JS
// fired them via a plain Module.ccall from a macrotask (no promising frame), the
// first suspension aborts with "trying to suspend without WebAssembly.promising".
//
// So the JS half does NOT call the cb directly. Instead it ENQUEUES the (req,
// status) pair here (nvim_sock_queue_connect / _queue_addrinfo) and wakes the
// poll (NvimIO.signalWake). A uv_check handle registered on the loop -- whose
// callback runs INSIDE uv_run, i.e. inside the engine's suspendable main frame
// -- then drains the queue and fires the cbs. Cbs may suspend freely there.
typedef struct {
  int kind;   // 0 = connect, 1 = addrinfo, 2 = incoming connection
  void *req;  // connect/getaddrinfo req, OR the listener's uv_stream_t* (kind 2)
  int status;
  int port;
} sock_pending_t;

# define SOCK_PENDING_CAP 64
static sock_pending_t g_sock_pending[SOCK_PENDING_CAP];
static int g_sock_pending_head = 0;
static int g_sock_pending_tail = 0;
static uv_check_t g_sock_check;
static int g_sock_check_started = 0;

// --- inbound listener table (per uv_stream_t* handle) ----------------------
// A SocketWatcher's bind stores its addr here; listen records the connection_cb
// and the real bound port; getsockname reads the bound host/port back. Keyed by
// the listener handle pointer (the uv_tcp_t/uv_pipe_t == the uv_stream_t).
typedef struct {
  void *handle;                 // the uv_stream_t* (NULL == free slot)
  uv_connection_cb conn_cb;     // set in __wrap_uv_listen
  int is_unix;                  // 0 = tcp, 1 = pipe
  char host[INET6_ADDRSTRLEN];  // tcp: the bound host (from uv_tcp_bind's addr)
  int port;                     // tcp: the REAL bound port (server-reported)
  int family;                   // AF_INET / AF_INET6 (tcp)
  char path[256];               // pipe: the bound path
} sock_listener_t;

# define SOCK_LISTENER_CAP 32
static sock_listener_t g_sock_listeners[SOCK_LISTENER_CAP];

static sock_listener_t *sock_listener_find(void *handle)
{
  for (int i = 0; i < SOCK_LISTENER_CAP; i++) {
    if (g_sock_listeners[i].handle == handle) {
      return &g_sock_listeners[i];
    }
  }
  return NULL;
}

static sock_listener_t *sock_listener_alloc(void *handle)
{
  sock_listener_t *e = sock_listener_find(handle);
  if (e != NULL) {
    return e;  // re-bind on the same handle: reuse the slot
  }
  for (int i = 0; i < SOCK_LISTENER_CAP; i++) {
    if (g_sock_listeners[i].handle == NULL) {
      memset(&g_sock_listeners[i], 0, sizeof(g_sock_listeners[i]));
      g_sock_listeners[i].handle = handle;
      return &g_sock_listeners[i];
    }
  }
  return NULL;  // table full
}

static void sock_drain_check(uv_check_t *check);

// Ensure the drain check handle is running on `loop` (registered once, the first
// time a socket connect/getaddrinfo is intercepted). A uv_check is a no-cost
// loop handle whose cb runs each loop iteration after polling.
static void sock_ensure_check(uv_loop_t *loop)
{
  if (g_sock_check_started) {
    return;
  }
  g_sock_check_started = 1;
  uv_check_init(loop, &g_sock_check);
  uv_check_start(&g_sock_check, sock_drain_check);
  // Don't let the check handle keep the loop alive on its own.
  uv_unref((uv_handle_t *)&g_sock_check);
}

static void sock_enqueue(int kind, void *req, int status, int port)
{
  int next = (g_sock_pending_tail + 1) % SOCK_PENDING_CAP;
  if (next == g_sock_pending_head) {
    return;  // full (should never happen in practice); drop rather than corrupt
  }
  g_sock_pending[g_sock_pending_tail].kind = kind;
  g_sock_pending[g_sock_pending_tail].req = req;
  g_sock_pending[g_sock_pending_tail].status = status;
  g_sock_pending[g_sock_pending_tail].port = port;
  g_sock_pending_tail = next;
}

// Fire one queued connect result. Runs on the main frame (inside uv_run).
static void sock_fire_connect(uv_connect_t *req, int status)
{
  if (req == NULL) {
    return;
  }
  uv_connect_cb cb = req->cb;
  // Unregister the req from the loop (real uv_tcp_connect's connect path does
  // this before invoking the cb). We registered it with uv__req_init.
  if (req->handle != NULL && req->handle->loop != NULL) {
    uv__req_unregister(req->handle->loop);
  }
  if (cb != NULL) {
    cb(req, status);
  }
}

// Fire one queued ASYNC getaddrinfo result. Runs on the main frame.
static void sock_fire_addrinfo(uv_getaddrinfo_t *req, int status, int port)
{
  if (req == NULL) {
    return;
  }
  uv_getaddrinfo_cb cb = (uv_getaddrinfo_cb)req->cb;
  if (req->loop != NULL) {
    uv__req_unregister(req->loop);
  }
  if (status != 0) {
    if (cb != NULL) {
      cb(req, status, NULL);
    }
    return;
  }
  char svc[16];
  snprintf(svc, sizeof(svc), "%d", port);
  struct addrinfo *ai = sock_synth_addrinfo(svc);
  req->addrinfo = ai;
  if (cb != NULL) {
    cb(req, ai ? 0 : UV_ENOMEM, ai);
  }
}

// Fire one queued incoming-connection event: call the listener's connection_cb
// on the main frame (it runs socket_watcher_accept -> uv_accept). Runs inside
// uv_run, so the cb may suspend (it reads the new client).
static void sock_fire_connection(uv_stream_t *server)
{
  if (server == NULL) {
    return;
  }
  sock_listener_t *l = sock_listener_find(server);
  if (l == NULL || l->conn_cb == NULL) {
    return;
  }
  l->conn_cb(server, 0);
}

// The uv_check callback: drain the pending queue, firing each cb on the main
// (suspendable) frame. A cb may itself enqueue more (rare), but each drains on
// the next loop iteration; we snapshot the tail so this pass is bounded.
static void sock_drain_check(uv_check_t *check)
{
  (void)check;
  int tail = g_sock_pending_tail;
  while (g_sock_pending_head != tail) {
    sock_pending_t p = g_sock_pending[g_sock_pending_head];
    g_sock_pending_head = (g_sock_pending_head + 1) % SOCK_PENDING_CAP;
    if (p.kind == 0) {
      sock_fire_connect((uv_connect_t *)p.req, p.status);
    } else if (p.kind == 1) {
      sock_fire_addrinfo((uv_getaddrinfo_t *)p.req, p.status, p.port);
    } else if (p.kind == 2) {
      sock_fire_connection((uv_stream_t *)p.req);
    }
  }
}

// EMSCRIPTEN_KEEPALIVE entries: the JS half calls these when the server's
// sock.connect_ok / sock.connect_err (or sock.addrinfo) arrives. They only
// ENQUEUE + return; the drain check fires the actual cb on the main frame. JS
// must signalWake() after calling these so the suspended poll resumes and the
// loop runs the check.
EMSCRIPTEN_KEEPALIVE
void nvim_sock_on_connect(uv_connect_t *req, int status)
{
  if (req == NULL) {
    return;
  }
  sock_enqueue(0, req, status, 0);
}

EMSCRIPTEN_KEEPALIVE
void nvim_sock_on_addrinfo_queued(uv_getaddrinfo_t *req, int status, int port)
{
  if (req == NULL) {
    return;
  }
  sock_enqueue(1, req, status, port);
}

// EMSCRIPTEN_KEEPALIVE: the JS half calls this (per pending incoming connection)
// when the server pushes sock.incoming for one of our listeners. `handle` is the
// listener's uv_stream_t*. It only ENQUEUES; the drain fires the connection_cb on
// the main frame. JS must signalWake() so the suspended poll resumes.
EMSCRIPTEN_KEEPALIVE
void nvim_sock_on_connection(void *handle)
{
  if (handle == NULL) {
    return;
  }
  sock_enqueue(2, handle, 0, 0);
}


// __wrap_uv_tcp_connect: the linker redirects every uv_tcp_connect call here.
int __wrap_uv_tcp_connect(uv_connect_t *req, uv_tcp_t *handle,
                          const struct sockaddr *addr, uv_connect_cb cb)
{
  // No proxy -> behave EXACTLY as today (the real uv_tcp_connect, which in wasm
  // has no usable network but is byte-for-byte the unchanged path).
  if (!nvim_proxy_active()) {
    return __real_uv_tcp_connect(req, handle, addr, cb);
  }

  // Extract host:port from the sockaddr (the synthesized addrinfo from our
  // getaddrinfo wrap, or a real numeric sockaddr from luv's uv.tcp_connect).
  char host[INET6_ADDRSTRLEN] = "127.0.0.1";
  int port = 0;
  if (addr->sa_family == AF_INET) {
    const struct sockaddr_in *in = (const struct sockaddr_in *)addr;
    uv_ip4_name(in, host, sizeof(host));
    port = ntohs(in->sin_port);
  } else if (addr->sa_family == AF_INET6) {
    const struct sockaddr_in6 *in6 = (const struct sockaddr_in6 *)addr;
    uv_ip6_name(in6, host, sizeof(host));
    port = ntohs(in6->sin6_port);
  }

  // Make sure the deferred-callback drain check is running on this loop so the
  // server's connect result fires the cb on the suspendable main frame.
  sock_ensure_check(handle->loop);

  // Back the uv_tcp_t with a virtual pollable fd (SPIKE S1): uv_tcp_open accepts
  // it, and uv_read_start / uv_write then flow over it.
  int fd = nvim_sock_alloc_fd();
  if (fd < 0) {
    // Mirror real uv_tcp_connect's contract on failure: register + fire cb with
    // an error so the caller's connect path completes (doesn't hang).
    uv__req_init(handle->loop, req, UV_CONNECT);
    req->cb = cb;
    req->handle = (uv_stream_t *)handle;
    nvim_sock_on_connect(req, UV_ENOMEM);
    return 0;
  }
  // CRITICAL: socket.c calls uv_tcp_nodelay(tcp, true) BEFORE connect, which sets
  // UV_HANDLE_TCP_NODELAY. uv_tcp_open -> uv__stream_open then does
  // setsockopt(TCP_NODELAY) on the fd -- which FAILS on our MEMFS-backed virtual
  // fd (it isn't a real socket; ENOTSOCK), making uv_tcp_open return an error and
  // NOT open the handle (so reads/writes silently go nowhere). Clear the TCP
  // option flags before opening; the REAL socket on the server already sets
  // TCP_NODELAY (net.setNoDelay), so no behavior is lost.
  handle->flags &= ~(unsigned int)(UV_HANDLE_TCP_NODELAY | UV_HANDLE_TCP_KEEPALIVE);
  uv_tcp_open(handle, fd);

  // Register the connect req with the loop so the loop stays alive until the cb
  // fires (real uv_tcp_connect does this; SPIKE S2). Balanced by
  // uv__req_unregister in nvim_sock_on_connect.
  uv__req_init(handle->loop, req, UV_CONNECT);
  req->cb = cb;
  req->handle = (uv_stream_t *)handle;

  // Fire sock.connect{host,port} async; the server's reply -> nvim_sock_on_connect.
  nvim_sock_connect(req, handle, fd, host, port);
  return 0;
}

// __wrap_uv_getaddrinfo: the linker redirects every uv_getaddrinfo call here.
int __wrap_uv_getaddrinfo(uv_loop_t *loop, uv_getaddrinfo_t *req,
                          uv_getaddrinfo_cb cb, const char *node,
                          const char *service, const struct addrinfo *hints)
{
  if (!nvim_proxy_active()) {
    return __real_uv_getaddrinfo(loop, req, cb, node, service, hints);
  }

  if (cb != NULL) {
    // ASYNC form (luv): register the req + fire the cb later from the deferred
    // drain (nvim_sock_on_addrinfo_queued). Stash the cb/loop on the req.
    req->loop = loop;
    req->cb = cb;
    req->addrinfo = NULL;
    uv__req_init(loop, req, UV_GETADDRINFO);
    sock_ensure_check(loop);
    nvim_sock_register_async(req, node ? node : "", service ? service : "");
    return 0;
  }

  // SYNC form (socket.c): SUSPEND via JSPI for the server round-trip, then
  // synthesize the heap addrinfo and return 0 (SPIKE S3). nvim_sock_resolve_sync
  // is __async; it returns a Promise the wasm frame suspends on.
  nvim_sock_resolve_sync(node ? node : "", service ? service : "");
  int status = nvim_sock_take_sync_status();
  if (status != 0) {
    req->addrinfo = NULL;
    return status;  // negative uv errno -> socket.c reports "failed to lookup host"
  }
  // The resolved port equals the requested numeric service (DNS resolves only the
  // host, carried separately to the server). Use the service the caller passed.
  struct addrinfo *ai = sock_synth_addrinfo(service);
  if (ai == NULL) {
    req->addrinfo = NULL;
    return UV_ENOMEM;
  }
  req->addrinfo = ai;
  return 0;
}

// __wrap_uv_freeaddrinfo: free OUR synthesized addrinfo (recognized by the
// sentinel in ai_canonname); delegate anything else to the real implementation.
void __wrap_uv_freeaddrinfo(struct addrinfo *ai)
{
  if (ai != NULL && ai->ai_canonname == SOCK_AI_SENTINEL) {
    struct addrinfo *cur = ai;
    while (cur != NULL) {
      struct addrinfo *next = cur->ai_next;
      free(cur->ai_addr);
      free(cur);
      cur = next;
    }
    return;
  }
  __real_uv_freeaddrinfo(ai);
}

// --- inbound listen/accept wraps -------------------------------------------
// nvim's serverstart() / luv s:bind()+s:listen()+s:accept() go through
// uv_tcp_bind/uv_pipe_bind -> uv_listen -> (connection_cb) -> uv_accept, with
// uv_tcp_getsockname to learn the real bound port. We don't bind/listen for real
// in wasm; instead we STORE the addr at bind, round-trip the server at listen
// (net.createServer), drive the connection_cb from the server's sock.incoming
// push (via the same uv_check drain), and pop accepted sockets onto virtual fds.

// __wrap_uv_tcp_bind: store the bound host:port (don't bind for real); return 0.
int __wrap_uv_tcp_bind(uv_tcp_t *handle, const struct sockaddr *addr,
                       unsigned int flags)
{
  if (!nvim_proxy_active()) {
    return __real_uv_tcp_bind(handle, addr, flags);
  }
  sock_listener_t *l = sock_listener_alloc(handle);
  if (l == NULL) {
    return UV_ENOMEM;
  }
  l->is_unix = 0;
  l->host[0] = '\0';
  l->port = 0;
  l->family = addr ? addr->sa_family : AF_INET;
  if (addr != NULL && addr->sa_family == AF_INET) {
    const struct sockaddr_in *in = (const struct sockaddr_in *)addr;
    uv_ip4_name(in, l->host, sizeof(l->host));
    l->port = ntohs(in->sin_port);
  } else if (addr != NULL && addr->sa_family == AF_INET6) {
    const struct sockaddr_in6 *in6 = (const struct sockaddr_in6 *)addr;
    uv_ip6_name(in6, l->host, sizeof(l->host));
    l->port = ntohs(in6->sin6_port);
  }
  if (l->host[0] == '\0') {
    strcpy(l->host, "127.0.0.1");
  }
  return 0;
}

// __wrap_uv_pipe_bind: store the bound path (don't bind for real); return 0.
int __wrap_uv_pipe_bind(uv_pipe_t *handle, const char *name)
{
  if (!nvim_proxy_active()) {
    return __real_uv_pipe_bind(handle, name);
  }
  sock_listener_t *l = sock_listener_alloc(handle);
  if (l == NULL) {
    return UV_ENOMEM;
  }
  l->is_unix = 1;
  if (name != NULL) {
    strncpy(l->path, name, sizeof(l->path) - 1);
    l->path[sizeof(l->path) - 1] = '\0';
  } else {
    l->path[0] = '\0';
  }
  return 0;
}

// __wrap_uv_listen: round-trip the server (SUSPEND via JSPI) to create the real
// listener. On success record the connection_cb + start the handle (so the loop
// stays alive while listening) + store the real bound port. On failure return a
// negative uv errno (nvim's socket_watcher_start handles it).
int __wrap_uv_listen(uv_stream_t *stream, int backlog, uv_connection_cb cb)
{
  if (!nvim_proxy_active()) {
    return __real_uv_listen(stream, backlog, cb);
  }
  sock_listener_t *l = sock_listener_find(stream);
  if (l == NULL) {
    // listen without a recognized bind: not one of ours -> real (will fail in
    // wasm, matching no-proxy behavior).
    return __real_uv_listen(stream, backlog, cb);
  }
  sock_ensure_check(stream->loop);

  // SUSPEND for the server round-trip. nvim_sock_listen_sync registers the
  // listener under `stream` and resolves with a status CATEGORY + the REAL bound
  // port, read back via the listen-specific slots.
  nvim_sock_listen_sync(stream, l->host, l->port, l->path, l->is_unix);
  int cat = nvim_sock_take_listen_status();
  if (cat != 0) {
    // Translate the JS category to the right compile-time UV_* errno (the exact
    // value is emscripten-errno-derived; socket.c's pipe stale-socket retry
    // matches on UV_EADDRINUSE / UV_EACCES, so the mapping must be exact).
    if (cat == -1) { return UV_EADDRINUSE; }
    if (cat == -2) { return UV_EACCES; }
    return UV_ECONNREFUSED;  // generic "couldn't listen"
  }
  if (!l->is_unix) {
    l->port = nvim_sock_take_listen_port();  // the real assigned port (random binds)
  }
  l->conn_cb = cb;
  // Keep the loop alive while listening (real uv_listen marks the handle active).
  uv__handle_start(stream);
  return 0;
}

// __wrap_uv_accept: pop the next pending incoming connection (already known from
// a sock.incoming push) onto a virtual fd, and uv_tcp_open/uv_pipe_open the
// client handle onto it. Synchronous (real uv_accept is). Returns 0 / -errno.
int __wrap_uv_accept(uv_stream_t *server, uv_stream_t *client)
{
  if (!nvim_proxy_active()) {
    return __real_uv_accept(server, client);
  }
  sock_listener_t *l = sock_listener_find(server);
  if (l == NULL) {
    return __real_uv_accept(server, client);
  }
  int fd = nvim_sock_alloc_fd();
  if (fd < 0) {
    return UV_ENOMEM;
  }
  // Pop the next pending connId onto this fd + tell the server to stream it.
  if (!nvim_sock_accept_next(server, fd)) {
    nvim_sock_close_fd(fd);
    return UV_EAGAIN;  // no pending connection (shouldn't happen post-incoming)
  }
  if (l->is_unix) {
    uv_pipe_open((uv_pipe_t *)client, fd);
  } else {
    // Clear TCP_NODELAY/KEEPALIVE before open: socket_watcher_accept sets nodelay
    // on the client first, and setsockopt on our non-socket fd would fail the open
    // (the same trap as the connect path).
    client->flags &= ~(unsigned int)(UV_HANDLE_TCP_NODELAY | UV_HANDLE_TCP_KEEPALIVE);
    uv_tcp_open((uv_tcp_t *)client, fd);
  }
  return 0;
}

// __wrap_uv_tcp_getsockname: for our listeners, fill the sockaddr from the stored
// bound host:port (so v:servername / luv getsockname report the REAL port, incl.
// the random-port case). Else delegate.
int __wrap_uv_tcp_getsockname(const uv_tcp_t *handle, struct sockaddr *name,
                              int *namelen)
{
  if (nvim_proxy_active()) {
    sock_listener_t *l = sock_listener_find((void *)handle);
    if (l != NULL && !l->is_unix && name != NULL && namelen != NULL) {
      if (l->family == AF_INET6) {
        struct sockaddr_in6 sa6;
        memset(&sa6, 0, sizeof(sa6));
        sa6.sin6_family = AF_INET6;
        sa6.sin6_port = htons((uint16_t)l->port);
        uv_inet_pton(AF_INET6, l->host, &sa6.sin6_addr);
        int n = (int)sizeof(sa6);
        if (*namelen < n) { n = *namelen; }
        memcpy(name, &sa6, (size_t)n);
        *namelen = (int)sizeof(sa6);
      } else {
        struct sockaddr_in sa;
        memset(&sa, 0, sizeof(sa));
        sa.sin_family = AF_INET;
        sa.sin_port = htons((uint16_t)l->port);
        uv_inet_pton(AF_INET, l->host, &sa.sin_addr);
        int n = (int)sizeof(sa);
        if (*namelen < n) { n = *namelen; }
        memcpy(name, &sa, (size_t)n);
        *namelen = (int)sizeof(sa);
      }
      return 0;
    }
  }
  return __real_uv_tcp_getsockname(handle, name, namelen);
}

// __wrap_uv_close: if the handle is one of our inbound LISTENERS, tell the server
// to close the real net.Server + drop our slot, then delegate. For EVERY other
// handle (the overwhelming majority -- streams, timers, the spawn/connect
// handles) this is a transparent pass-through to __real_uv_close, so behavior is
// byte-identical except for our listeners. (Connected client sockets close via
// their fd's ch.onClose -> sock.close, not here.)
void __wrap_uv_close(uv_handle_t *handle, uv_close_cb close_cb)
{
  if (nvim_proxy_active() && handle != NULL) {
    sock_listener_t *l = sock_listener_find(handle);
    if (l != NULL) {
      nvim_sock_listen_close(handle);
      l->handle = NULL;  // free the slot
      // The handle was uv__handle_start'd in __wrap_uv_listen; __real_uv_close
      // does the matching uv__handle_stop + the close-cb dance.
    }
  }
  __real_uv_close(handle, close_cb);
}

// --- unix-domain (pipe) connect wraps --------------------------------------
// nvim sockconnect('pipe', path) (socket.c's else branch) and luv
// vim.uv.new_pipe():connect(path, cb) both go through uv_pipe_connect; luv's
// pipe_connect2 goes through uv_pipe_connect2. Both connect by PATH (a unix
// socket on the server), so there is NO getaddrinfo, NO sockaddr, and NO nodelay
// trap (uv_pipe_open on a virtual fd is clean -- it only fcntl's, never
// setsockopt's). Otherwise this mirrors __wrap_uv_tcp_connect exactly: back the
// uv_pipe_t with the SAME virtual pollable fd, uv__req_init the connect req, fire
// sock.connect{path} async, and let the server's sock.connect_ok / sock.connect_err
// push drive the connect cb via the shared enqueue + uv_check drain.
//
// Shared body for both wraps. Returns 0 on success (cb will fire later) or a
// negative uv errno after firing the cb with that error (so the caller's connect
// path completes rather than hangs).
static int sock_pipe_connect_common(uv_connect_t *req, uv_pipe_t *handle,
                                    const char *name, uv_connect_cb cb)
{
  // Make sure the deferred-callback drain check is running on this loop.
  sock_ensure_check(handle->loop);

  int fd = nvim_sock_alloc_fd();
  if (fd < 0) {
    uv__req_init(handle->loop, req, UV_CONNECT);
    req->cb = cb;
    req->handle = (uv_stream_t *)handle;
    nvim_sock_on_connect(req, UV_ENOMEM);
    return UV_ENOMEM;
  }
  // uv_pipe_open accepts a MEMFS-backed virtual fd (proven by spikeB / the
  // shipped spawn-stdio path): it only fcntl's the fd, never uv_guess_handle's or
  // setsockopt's. No flag-clearing needed (no TCP_NODELAY on a pipe).
  uv_pipe_open(handle, fd);

  // Register the connect req with the loop so it stays alive until the cb fires.
  uv__req_init(handle->loop, req, UV_CONNECT);
  req->cb = cb;
  req->handle = (uv_stream_t *)handle;

  // Fire sock.connect{path} async; the server's reply -> nvim_sock_on_connect.
  nvim_sock_connect_unix(req, handle, fd, name ? name : "");
  return 0;
}

// __wrap_uv_pipe_connect: the void form (errors reported via cb only). nvim
// socket.c and luv vim.uv.new_pipe():connect both land here.
void __wrap_uv_pipe_connect(uv_connect_t *req, uv_pipe_t *handle,
                            const char *name, uv_connect_cb cb)
{
  if (!nvim_proxy_active()) {
    __real_uv_pipe_connect(req, handle, name, cb);
    return;
  }
  (void)sock_pipe_connect_common(req, handle, name, cb);
}

// __wrap_uv_pipe_connect2: the int form (luv pipe_connect2). A sync validation
// error returns a negative uv errno; otherwise 0 and the cb fires later. The
// abstract-namespace flag (UV_PIPE_NO_TRUNCATE etc.) is irrelevant to the proxy
// (the server opens the path verbatim), so we ignore `namelen`/`flags` and route
// by the NUL-terminated name -- unix socket PATHS (the only thing the server can
// connect) are NUL-terminated, not abstract-namespace.
int __wrap_uv_pipe_connect2(uv_connect_t *req, uv_pipe_t *handle,
                            const char *name, size_t namelen,
                            unsigned int flags, uv_connect_cb cb)
{
  if (!nvim_proxy_active()) {
    return __real_uv_pipe_connect2(req, handle, name, namelen, flags, cb);
  }
  return sock_pipe_connect_common(req, handle, name, cb);
}

#endif  // __EMSCRIPTEN__
