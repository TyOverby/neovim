// Some of the code came from pangoterm and libuv

#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <uv.h>

// forkpty is not in POSIX, so headers are platform-specific
#if defined(__FreeBSD__) || defined(__DragonFly__)
# include <libutil.h>
// TODO(bfredl): this is available on darwin, but there is an issue with cross-compile headers
#elif defined(__APPLE__) && !defined(HAVE_FORKPTY)
int forkpty(int *, char *, const struct termios *, const struct winsize *);
#elif defined(__OpenBSD__) || defined(__NetBSD__) || defined(__APPLE__)
# include <util.h>
#elif defined(__sun)
# include <fcntl.h>
# include <signal.h>
# include <sys/stream.h>
# include <sys/syscall.h>
# include <unistd.h>
#else
# include <pty.h>
#endif

#ifdef __APPLE__
# include <crt_externs.h>
#endif
#ifdef __linux__
# include <poll.h>
#endif

#include "auto/config.h"
#include "klib/kvec.h"
#include "nvim/eval/typval.h"
#include "nvim/event/defs.h"
#include "nvim/event/loop.h"
#include "nvim/event/proc.h"
#include "nvim/log.h"
#include "nvim/os/fs.h"
#include "nvim/os/os_defs.h"
#include "nvim/os/pty_proc.h"
#include "nvim/os/pty_proc_unix.h"
#include "nvim/types_defs.h"

#include "os/pty_proc_unix.c.generated.h"

#ifdef __EMSCRIPTEN__
# include "nvim/memory.h"   // xmalloc / xfree
# include "nvim/os/os.h"    // tv_dict_to_env / os_free_fullenv
// Stage 4 / Phase 5 (additive, opt-in): when an IO-proxy is configured, run a
// :terminal child on the server over a single BIDIRECTIONAL virtual fd instead
// of forkpty() (no fork/openpty under wasm). Every branch below is gated on
// nvim_proxy_active(); the native forkpty/ioctl path stays byte-identical.
//
// JS bridge (implemented in wasm/nvim_proc_proxy.js):
// nonzero iff globalThis.__nvimProxy is present (a proxy is configured).
extern int nvim_proxy_active(void);
// Allocate ONE virtual pollable fd usable for BOTH reading (server pty output)
// and writing (terminal input). Returns the fd (>= 0) or -1 on failure. mode 2
// = bidirectional (cf. mode 0 readable / 1 writable in the proc-spawn path).
extern int nvim_proxy_alloc_fd(int mode);
// Open a SECOND FS stream onto the SAME virtual channel as `fd` (so nvim can dup
// the one master into proc->in and proc->out, mirroring the native dup()). The
// two streams share the channel; reads drain server output, writes send input.
extern int nvim_proxy_pty_dup_fd(int fd);
// Request `pty.spawn` from the server (argv/env are NUL-separated) wired to the
// virtual fd, plus the initial cols/rows. Registers the Proc* handle so pty.data
// / pty.exit pushes route to it. Returns the server pty id (>= 0) or < 0.
extern int nvim_proxy_pty_spawn(void *handle, const char *argv, const char *cwd,
                                const char *env, int fd, int cols, int rows);
// Send `pty.resize` to the server for this handle's pty.
extern void nvim_proxy_pty_resize(void *handle, int cols, int rows);
// Kill the server pty (close path); the server's `pty.exit` push then drives the
// normal exit/close/refcount flow.
extern void nvim_proxy_pty_kill(void *handle, int signum);
#endif

#if !defined(HAVE_FORKPTY) && !defined(__APPLE__)

// this header defines STR, just as nvim.h, but it is defined as ('S'<<8),
// to avoid #undef STR, #undef STR, #define STR ('S'<<8) just delay the
// inclusion of the header even though it gets include out of order.

# if !defined(__HAIKU__)
#  include <sys/stropts.h>
# else
#  define I_PUSH 0  // XXX: find the actual value
# endif

static int vim_openpty(int *amaster, int *aslave, char *name, struct termios *termp,
                       struct winsize *winp)
{
  int slave = -1;
  int master = open("/dev/ptmx", O_RDWR);
  if (master == -1) {
    goto error;
  }

  // grantpt will invoke a setuid program to change permissions
  // and might fail if SIGCHLD handler is set, temporarily reset
  // while running
  void (*sig_saved)(int) = signal(SIGCHLD, SIG_DFL);
  int res = grantpt(master);
  signal(SIGCHLD, sig_saved);

  if (res == -1 || unlockpt(master) == -1) {
    goto error;
  }

  char *slave_name = ptsname(master);
  if (slave_name == NULL) {
    goto error;
  }

  slave = open(slave_name, O_RDWR|O_NOCTTY);
  if (slave == -1) {
    goto error;
  }

  // ptem emulates a terminal when used on a pseudo terminal driver,
  // must be pushed before ldterm
  ioctl(slave, I_PUSH, "ptem");
  // ldterm provides most of the termio terminal interface
  ioctl(slave, I_PUSH, "ldterm");
  // ttcompat compatibility with older terminal ioctls
  ioctl(slave, I_PUSH, "ttcompat");

  if (termp) {
    tcsetattr(slave, TCSAFLUSH, termp);
  }
  if (winp) {
    ioctl(slave, TIOCSWINSZ, winp);
  }

  *amaster = master;
  *aslave = slave;
  // ignoring name, not passed and size is unknown in the API

  return 0;

error:
  if (slave != -1) {
    close(slave);
  }
  if (master != -1) {
    close(master);
  }
  return -1;
}

static int vim_login_tty(int fd)
{
  setsid();
  if (ioctl(fd, TIOCSCTTY, NULL) == -1) {
    return -1;
  }

  dup2(fd, STDIN_FILENO);
  dup2(fd, STDOUT_FILENO);
  dup2(fd, STDERR_FILENO);
  if (fd > STDERR_FILENO) {
    close(fd);
  }

  return 0;
}

pid_t vim_forkpty(int *amaster, char *name, struct termios *termp, struct winsize *winp)
{
  int master, slave;
  if (vim_openpty(&master, &slave, name, termp, winp) == -1) {
    return -1;
  }

  pid_t pid = fork();
  switch (pid) {
  case -1:
    close(master);
    close(slave);
    return -1;
  case 0:
    close(master);
    vim_login_tty(slave);
    return 0;
  default:
    close(slave);
    *amaster = master;
    return pid;
  }
}
# define forkpty vim_forkpty
#endif

/// @returns zero on success, or negative error code
int pty_proc_spawn(PtyProc *ptyproc)
  FUNC_ATTR_NONNULL_ALL
{
  // termios initialized at first use
  static struct termios termios_default;
  if (!termios_default.c_cflag) {
    init_termios(&termios_default);
  }

  int status = 0;  // zero or negative error code (libuv convention)
  Proc *proc = (Proc *)ptyproc;
  assert(proc->err.s.closed);

#ifdef __EMSCRIPTEN__
  // Stage 4 / Phase 5 (additive, opt-in): proxy the pty to the server. The native
  // forkpty path below is skipped entirely when a proxy is active.
  if (nvim_proxy_active()) {
    return pty_proc_spawn_proxy(ptyproc);
  }
#endif

  uv_signal_start(&proc->loop->children_watcher, chld_handler, SIGCHLD);
  ptyproc->winsize = (struct winsize){ ptyproc->height, ptyproc->width, 0, 0 };
  uv_disable_stdio_inheritance();
  int master;
  int pid = forkpty(&master, NULL, &termios_default, &ptyproc->winsize);

  if (pid < 0) {
    status = -errno;
    ELOG("forkpty failed: %s", strerror(errno));
    return status;
  } else if (pid == 0) {
    init_child(ptyproc);  // never returns
  }

  // make sure the master file descriptor is non blocking
  int master_status_flags = fcntl(master, F_GETFL);
  if (master_status_flags == -1) {
    status = -errno;
    ELOG("Failed to get master descriptor status flags: %s", strerror(errno));
    goto error;
  }
  if (fcntl(master, F_SETFL, master_status_flags | O_NONBLOCK) == -1) {
    status = -errno;
    ELOG("Failed to make master descriptor non-blocking: %s", strerror(errno));
    goto error;
  }

  // Other jobs and providers should not get a copy of this file descriptor.
  if (os_set_cloexec(master) == -1) {
    status = -errno;
    ELOG("Failed to set CLOEXEC on ptmx file descriptor");
    goto error;
  }

  if (!proc->in.closed
      && (status = set_duplicating_descriptor(master, &proc->in.uv.pipe))) {
    goto error;
  }
  if (!proc->out.s.closed
      && (status = set_duplicating_descriptor(master, &proc->out.s.uv.pipe))) {
    goto error;
  }

  ptyproc->tty_fd = master;
  proc->pid = pid;
  return 0;

error:
  close(master);
  kill(pid, SIGKILL);
  waitpid(pid, NULL, 0);
  return status;
}

#ifdef __EMSCRIPTEN__
// Stage 4 / Phase 5: flatten a NULL-terminated string vector into a NUL-
// separated, double-NUL-terminated buffer (the same wire shape proxy_proc.c
// uses; wasm/nvim_proc_proxy.js readStrv() splits it). Caller xfree()s.
static char *pty_flatten_strv(char **strv)
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
  buf[off++] = '\0';
  return buf;
}

/// Stage 4 / Phase 5: spawn a :terminal child on the IO-proxy server instead of
/// forkpty(). Mirrors the native master-fd wiring exactly: the native code dup()s
/// ONE pty master into proc->in AND proc->out (a pty is one bidirectional stream;
/// proc->err is always closed). Here we allocate ONE bidirectional virtual fd, open
/// a SECOND FS stream onto the SAME channel (the analogue of dup), and uv_pipe_open
/// the readable stream into proc->out and the writable stream into proc->in. After
/// we return, proc_spawn()'s type-agnostic stream_init() wires them like the uv
/// backend. Returns 0 on success (proc->pid = server pty id) or a negative error.
static int pty_proc_spawn_proxy(PtyProc *ptyproc)
  FUNC_ATTR_NONNULL_ALL
{
  Proc *proc = (Proc *)ptyproc;
  ptyproc->winsize = (struct winsize){ ptyproc->height, ptyproc->width, 0, 0 };

  // One bidirectional virtual fd backs the whole pty (read = server output,
  // write = terminal input).
  int fd = nvim_proxy_alloc_fd(2 /* bidirectional */);
  if (fd < 0) {
    return UV_ENOMEM;
  }
  ptyproc->tty_fd = fd;

  // Mirror set_duplicating_descriptor(): nvim's pty wires the master into BOTH
  // proc->in (write side) and proc->out (read side). Open a second FS stream on
  // the same channel for the second pipe (a virtual dup).
  if (!proc->out.s.closed) {
    int rc = uv_pipe_open(&proc->out.s.uv.pipe, fd);
    if (rc) {
      return rc;
    }
  }
  if (!proc->in.closed) {
    int fd2 = nvim_proxy_pty_dup_fd(fd);
    if (fd2 < 0) {
      return UV_ENOMEM;
    }
    int rc = uv_pipe_open(&proc->in.uv.pipe, fd2);
    if (rc) {
      return rc;
    }
  }

  char *argv_buf = pty_flatten_strv(proc->argv);
  char **fullenv = NULL;
  char *env_buf;
  if (proc->env) {
    fullenv = tv_dict_to_env(proc->env);
    env_buf = pty_flatten_strv(fullenv);
  } else {
    env_buf = pty_flatten_strv(NULL);
  }
  const char *cwd = proc->cwd ? proc->cwd : "";

  int pty_id = nvim_proxy_pty_spawn(proc, argv_buf, cwd, env_buf, fd,
                                    ptyproc->width, ptyproc->height);

  xfree(argv_buf);
  xfree(env_buf);
  if (fullenv) {
    os_free_fullenv(fullenv);
  }

  if (pty_id < 0) {
    return UV_ENOENT;
  }
  // Use the server pty id as the pid (opaque, positive, unique per child).
  proc->pid = pty_id;
  return 0;
}
#endif

const char *pty_proc_tty_name(PtyProc *ptyproc)
{
  return ptsname(ptyproc->tty_fd);
}

void pty_proc_resize(PtyProc *ptyproc, uint16_t width, uint16_t height)
  FUNC_ATTR_NONNULL_ALL
{
  ptyproc->winsize = (struct winsize){ height, width, 0, 0 };
#ifdef __EMSCRIPTEN__
  // Stage 4 / Phase 5: no master fd to ioctl(TIOCSWINSZ); ask the server's pty.
  if (nvim_proxy_active()) {
    nvim_proxy_pty_resize((Proc *)ptyproc, width, height);
    return;
  }
#endif
  ioctl(ptyproc->tty_fd, TIOCSWINSZ, &ptyproc->winsize);
}

void pty_proc_resume(PtyProc *ptyproc)
  FUNC_ATTR_NONNULL_ALL
{
  // Send SIGCONT to the entire process group, as some shells (e.g. fish) don't
  // propagate SIGCONT to suspended child processes.
  killpg(((Proc *)ptyproc)->pid, SIGCONT);
}

/// On Linux, libuv's polling (which uses epoll) doesn't flush PTY master's pending
/// work on kernel workqueue, so use an explicit poll() before that. #37982
/// Note that poll() only flushes pending work if no data is immediately available,
/// so this function is needed before every libuv poll in flush_stream().
void pty_proc_flush_master(PtyProc *ptyproc)
  FUNC_ATTR_NONNULL_ALL
{
#ifdef __linux__
  struct pollfd pollfd = { .fd = ptyproc->tty_fd, .events = POLLIN };
  int n = 0;
  do {
    n = poll(&pollfd, 1, 0);
  } while (n < 0 && errno == EINTR);
#endif
}

void pty_proc_close(PtyProc *ptyproc)
  FUNC_ATTR_NONNULL_ALL
{
  pty_proc_close_master(ptyproc);
  Proc *proc = (Proc *)ptyproc;
  if (proc->internal_close_cb) {
    proc->internal_close_cb(proc);
  }
}

void pty_proc_close_master(PtyProc *ptyproc)
  FUNC_ATTR_NONNULL_ALL
{
#ifdef __EMSCRIPTEN__
  // Stage 4 / Phase 5: there is no real master fd to close -- the virtual fd(s)
  // are owned by nvim's in/out pipe streams and freed by their uv_close/FS.close
  // teardown (the JS side releases its bookkeeping on the pty.exit push). What
  // closing the master DOES on a native pty is hang up the child (SIGHUP via the
  // session); the proxy equivalent is to ask the server to kill the pty. The
  // server's `pty.exit` push then drives the normal exit/close/refcount flow.
  if (nvim_proxy_active()) {
    if (ptyproc->tty_fd >= 0) {
      nvim_proxy_pty_kill((Proc *)ptyproc, SIGHUP);
      ptyproc->tty_fd = -1;
    }
    return;
  }
#endif
  if (ptyproc->tty_fd >= 0) {
    close(ptyproc->tty_fd);
    ptyproc->tty_fd = -1;
  }
}

void pty_proc_teardown(Loop *loop)
{
  uv_signal_stop(&loop->children_watcher);
}

static void init_child(PtyProc *ptyproc)
  FUNC_ATTR_NONNULL_ALL FUNC_ATTR_NORETURN
{
#if defined(HAVE__NSGETENVIRON)
# define environ (*_NSGetEnviron())
#else
  extern char **environ;
#endif
  // New session/process-group. #6530
  setsid();

  signal(SIGCHLD, SIG_DFL);
  signal(SIGHUP, SIG_DFL);
  signal(SIGINT, SIG_DFL);
  signal(SIGQUIT, SIG_DFL);
  signal(SIGTERM, SIG_DFL);
  signal(SIGALRM, SIG_DFL);

  Proc *proc = (Proc *)ptyproc;
  int err = 0;
  // Don't use os_chdir() as that may buffer UI events unnecessarily.
  if (proc->cwd && (err = uv_chdir(proc->cwd)) != 0) {
    ELOG("chdir(%s) failed: %s", proc->cwd, uv_strerror(err));
    _exit(122);
  }

  const char *prog = proc_get_exepath(proc);

  assert(proc->env);
  environ = tv_dict_to_env(proc->env);
  execvp(prog, proc->argv);
  ELOG("execvp(%s) failed: %s", prog, strerror(errno));

  _exit(122);  // 122 is EXEC_FAILED in the Vim source.
}

static void init_termios(struct termios *termios) FUNC_ATTR_NONNULL_ALL
{
  // Taken from pangoterm
  termios->c_iflag = ICRNL|IXON;
  termios->c_oflag = OPOST|ONLCR;
#ifdef TAB0
  termios->c_oflag |= TAB0;
#endif
  termios->c_cflag = CS8|CREAD;
  termios->c_lflag = ISIG|ICANON|IEXTEN|ECHO|ECHOE|ECHOK;

  // not using cfsetspeed, not available on all platforms
  cfsetispeed(termios, 38400);
  cfsetospeed(termios, 38400);

#ifdef IUTF8
  termios->c_iflag |= IUTF8;
#endif
#ifdef NL0
  termios->c_oflag |= NL0;
#endif
#ifdef CR0
  termios->c_oflag |= CR0;
#endif
#ifdef BS0
  termios->c_oflag |= BS0;
#endif
#ifdef VT0
  termios->c_oflag |= VT0;
#endif
#ifdef FF0
  termios->c_oflag |= FF0;
#endif
#ifdef ECHOCTL
  termios->c_lflag |= ECHOCTL;
#endif
#ifdef ECHOKE
  termios->c_lflag |= ECHOKE;
#endif

  termios->c_cc[VINTR] = 0x1f & 'C';
  termios->c_cc[VQUIT] = 0x1f & '\\';
  termios->c_cc[VERASE] = 0x7f;
  termios->c_cc[VKILL] = 0x1f & 'U';
  termios->c_cc[VEOF] = 0x1f & 'D';
  termios->c_cc[VEOL] = _POSIX_VDISABLE;
  termios->c_cc[VEOL2] = _POSIX_VDISABLE;
  termios->c_cc[VSTART] = 0x1f & 'Q';
  termios->c_cc[VSTOP] = 0x1f & 'S';
  termios->c_cc[VSUSP] = 0x1f & 'Z';
#if !defined(__HAIKU__)
  termios->c_cc[VREPRINT] = 0x1f & 'R';
  termios->c_cc[VWERASE] = 0x1f & 'W';
  termios->c_cc[VLNEXT] = 0x1f & 'V';
#endif
  termios->c_cc[VMIN] = 1;
  termios->c_cc[VTIME] = 0;
}

static int set_duplicating_descriptor(int fd, uv_pipe_t *pipe)
  FUNC_ATTR_NONNULL_ALL
{
  int status = 0;  // zero or negative error code (libuv convention)
  int fd_dup = dup(fd);
  if (fd_dup < 0) {
    status = -errno;
    ELOG("Failed to dup descriptor %d: %s", fd, strerror(errno));
    return status;
  }

  if (os_set_cloexec(fd_dup) == -1) {
    status = -errno;
    ELOG("Failed to set CLOEXEC on duplicate fd");
    goto error;
  }

  status = uv_pipe_open(pipe, fd_dup);
  if (status) {
    ELOG("Failed to set pipe to descriptor %d: %s",
         fd_dup, uv_strerror(status));
    goto error;
  }
  return status;

error:
  close(fd_dup);
  return status;
}

static void chld_handler(uv_signal_t *handle, int signum)
{
  int stat = 0;
  int pid;

  Loop *loop = handle->loop->data;

  for (size_t i = 0; i < kv_size(loop->children); i++) {
    Proc *proc = kv_A(loop->children, i);
    do {
      pid = waitpid(proc->pid, &stat, WNOHANG|WUNTRACED|WCONTINUED);
    } while (pid < 0 && errno == EINTR);

    if (pid <= 0) {
      continue;
    }

    if (WIFSTOPPED(stat)) {
      proc->state_cb(proc, true, proc->data);
      continue;
    }
    if (WIFCONTINUED(stat)) {
      proc->state_cb(proc, false, proc->data);
      continue;
    }

    if (WIFEXITED(stat)) {
      proc->status = WEXITSTATUS(stat);
    } else if (WIFSIGNALED(stat)) {
      proc->status = 128 + WTERMSIG(stat);
    }
    proc->internal_exit_cb(proc);
  }
}

PtyProc pty_proc_init(Loop *loop, void *data)
{
  PtyProc rv = { 0 };
  rv.proc = proc_init(loop, kProcTypePty, data);
  rv.width = 80;
  rv.height = 24;
  rv.tty_fd = -1;
  return rv;
}
