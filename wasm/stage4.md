# Stage 4 — The standalone application (server-proxied IO)

> **Status: shipped.** Phases 0–6 are complete. Visiting the server
> (`node wasm/server/server.js --root <dir> --port <p>`, then
> `http://localhost:<p>/`) gives a full in-browser editor whose filesystem, `:!`,
> `jobstart()`, `:terminal`, and LSP all run **on the server**, jailed to `--root`.
> See **What shipped** below for the summary and the one known gap (TCP sockets).
> The quickstart lives in `README.md` → "As a standalone application".

Stages 1–3 produced a Neovim engine cross-compiled to wasm that runs **entirely
in the browser** (engine in a Web Worker, pure-JS UI on the page, postMessage
transport, `poll()` suspending via JSPI). It is self-contained: no backend, no
network round-trip per keystroke. But it is also *sandboxed* — MEMFS only, and
every `uv_spawn`/`forkpty` path returns `ENOSYS`, so there is no real filesystem,
no `:!`, no `jobstart()`, no `:terminal`, and no LSP.

Stage 4 is the most ambitious target in `README.md` (**"As a standalone
application"**): keep the engine running locally in the browser — so editing and
plugin execution stay lightning-fast — but **proxy all real IO to a server**
running on the machine you actually care about. Filesystem access, process
spawning, PTYs, LSP servers, and (eventually) network connections all run *for
real* on the server, while the editor itself never leaves your browser. This is
the inverse of the usual remote-Neovim setup: instead of the engine being remote
and the keystrokes travelling the wire, the **engine is local** and only the
*IO* travels the wire — and IO is far less latency-sensitive than per-keystroke
redraw.

Prereq reading: `stage3.md` (the browser architecture) and the "Filesystem:
MEMFS + NODEFS" + "Architecture" sections of `README.md`.

## The shape

```
   browser page (UI)            engine Web Worker                server (Node, on your box)
   ┌──────────────────┐ postMsg ┌────────────────────┐ WebSocket ┌──────────────────────────┐
   │ keydown→nvim_input┼────────▶│ nvim --embed (wasm)│◀─────────▶│ real FS / child procs /  │
   │ redraw →grid→<pre>◀┼────────┤ editor+ext_linegrid│  proxy    │ PTYs / LSP / sockets     │
   └──────────────────┘         │ poll() ⇄ JSPI      │  RPC      │  (run for real here)     │
                                └────────────────────┘           └──────────────────────────┘
        UI thread, no wasm         engine + IO proxy client            your machine's IO
```

Two transports, deliberately separate:

1. **UI transport (unchanged):** page ⇄ engine worker over `postMessage`, carrying
   msgpack-RPC (`nvim_input` out, `redraw` in). This is stage 3 and does not
   change.
2. **IO-proxy transport (new):** the **engine worker** opens its *own* WebSocket
   straight to the server and speaks a small framed proxy protocol. IO requests
   never touch the UI thread, and the suspension model that makes blocking wasm
   usable (JSPI `poll()`) already lives in the worker — so the proxy reuses it.

Putting the WebSocket in the worker (not the page) means the page stays a pure UI
that knows nothing about IO, and a request like "read this file" is one hop
(worker→server), not two (worker→page→server).

## Invariant: additive and opt-in

The standalone app is a **superset**, never a replacement. The embeddable-UI-widget
use case (the "As a library" API — `create()`, `mount_into`, the headless core,
the renderer, the helpers, clipboard) must keep working **exactly as today**. So:

- All proxy behaviour activates only when an embedder passes a **`proxy` config**
  to `create()` (server URL + jail root + mount prefix). With no `proxy`, there is
  **no server connection** and every code path behaves as it does now — MEMFS-only,
  `:!`/`jobstart`/`:terminal` still `ENOSYS`, the library fully self-contained.
- The wasm-side hooks (async FS syscall overrides, the `proc_spawn` proxy backend)
  must **fall through to current behaviour** when no proxy is configured: the async
  FS override returns synchronously for every path when there is no proxy mount, and
  the `proc_spawn` backend is only taken when a proxy is present.
- Existing APIs may be **extended** (new optional options/fields) but not changed in
  a way that breaks current callers. The existing Node e2e (`wasm/web/e2e.test.js`)
  must stay green at every phase.

## The two interception seams (both de-risked by spikes — see below)

### Seam 1 — filesystem: async syscall overrides

Emscripten's FS is synchronous in C, but the engine already proves a syscall can
be made to **suspend via JSPI** (`__syscall_poll` in `wasm/nvim_io.js`). Stage 4
generalizes that: override the file-IO syscalls — `__syscall_openat` (open),
`fd_read` (read; note: **WASI `fd_read`, not `__syscall_read`**, in emcc 3.1.69),
`__syscall_fstat64`/`__syscall_newfstatat` (stat), `__syscall_close` — and mark
them `__async`. For a path under a configured **proxy mount prefix** (e.g.
`/host`), the override returns a `Promise` that round-trips the server and the
calling wasm frame suspends until the bytes arrive; for every other path it
returns synchronously and MEMFS (runtime, scratch, `/tmp`) stays fast and local.

This is the browser analogue of the Node build's NODEFS mount: under Node the
real filesystem is mounted into the wasm FS (`pre.js`); in the browser the
"real filesystem" is the *server's*, reached over the proxy. nvim's real file IO
already funnels through these syscalls (the build uses MEMFS+NODEFS, **not**
NODERAWFS, precisely so fds stay virtual and interceptable), so this is the
correct seam.

Constraints proven out (so the implementer doesn't rediscover them):
- The sync fast path must `return` a plain integer, never a Promise (else every
  MEMFS open needlessly suspends).
- The async `__syscall_openat` override must prime `SYSCALLS.varargs = varargs`
  before reading the variadic `mode`, or it aborts on an assertion.
- Virtual host fds are allocated above the MEMFS range (≥100000) and tracked in a
  side map; `fd_read`/`fstat`/`close` consult that map first, else delegate.

### Seam 2 — processes/PTY: virtual pollable fds + the proc_spawn backend

Neovim already abstracts spawning behind `proc_spawn(Proc*, …)` in
`src/nvim/event/proc.c`, dispatching to `libuv_proc_spawn` (`uv_spawn`) or
`pty_proc_spawn` (`forkpty`). Stage 4 adds an `if(EMSCRIPTEN)` **proxy backend**
there rather than fighting libuv's process internals. The child's
stdin/stdout/stderr become **virtual pollable fds** — a generalization of the
single fd 0/1 channel mechanism in `nvim_io.js` (`applyChannelOps`: queue-backed
`read`/`write`/`poll` stream ops + a wake) into a small fd table. The server runs
the real process and streams its bytes over the proxy connection into those
queues; the engine's existing `__syscall_poll` wakes on them.

The spike confirmed the real wiring works: `uv_pipe_open(fd)` accepts a virtual
fd with no special-casing (it only `fcntl`s, never `uv_guess_handle`s), and
`uv_read_start` then delivers async-pushed bytes to nvim's read callback under
the posix-poll backend. The one requirement is a truthy `stream.tty` marker so
nvim's `stream_init` → `uv_guess_handle(fd)` returns `UV_TTY` (the pipe path)
rather than `UV_FILE` (which would EOF immediately) — the same trick already used
for fd 0/1 (`nvim_io.js:71-72`). The proxy backend bypasses libuv's own
`uv_pipe()` pair-creation (`pipe2`/`socketpair`, unavailable in wasm) and
substitutes our virtual fds, then hands them to `uv_pipe_open` exactly as the
existing pre-existing-fd path does (`libuv_proc.c:96,102`).

**LSP comes (almost) for free:** nvim's built-in LSP client spawns the language
server as a stdio job, so once spawn+stdio works, an LSP running on the server
"just works" with no LSP-specific code.

PTY (`:terminal`) is the same virtual-fd model plus a resize control message; the
server allocates a real PTY (`node-pty`) and streams it.

## Security model

The server is a **remote-code-execution surface by design**: `:!rm -rf`,
`:terminal`, and any `jobstart()` run real commands on the host with the server
process's privileges. The defaults reflect that:

- **Bind `127.0.0.1` only** (loopback). Exposing it to a network is an explicit,
  documented opt-in, not the default.
- The server is intended for the single-user "edit my own remote box" case the
  README describes (you start the server on a machine you own and visit the page
  it hosts). It is **not** a multi-tenant sandbox.
- The filesystem proxy is **jailed to a configured root** so a stray `/etc/passwd`
  open can't escape the project the user pointed it at.

(A shared-token handshake is a straightforward later addition for the
expose-to-LAN case; the loopback default is the load-bearing protection.)

## Plan of record (phases) — all shipped

Each phase was built by a focused agent, verified with a Node e2e test **and** a
real-browser smoke test, and committed before the next began — the same cadence
as the library work in stage 3. **All seven phases (0–6) are done.**

| Phase | Deliverable | Test | Status |
|---|---|---|---|
| **0** | This doc + an honest README "Standalone application" section + a status row. | — | ✅ |
| **1** | Proxy transport + `wasm/server/server.js` skeleton: framed protocol, worker WebSocket (postMessage/in-process transport under Node), a C-visible js-library to send-and-await over the proxy (JSPI), the generalized proxy-fd table, a handler registry (stubs). | protocol ping/echo round-trip (`proxy.test.js`) | ✅ |
| **2** | Filesystem proxy (seam 1): async syscall overrides scoped to the mount prefix; server FS handlers jailed to a root. | open/edit/`:w` a file that lives only on the server's disk; `:e <dir>` (`fs-proxy.test.js`) | ✅ |
| **3** | Process spawn + stdio (seam 2): wasm `proc_spawn` proxy path; server `child_process` handler. | `system('echo hi')`, `jobstart` + `on_stdout`, non-zero exit, stdin pipe (`proc-proxy.test.js`) | ✅ |
| **4** | LSP smoke (mostly falls out of phase 3): a fixture language server + an `initialize` round-trip test. | LSP `initialize` completes over a proxied stdio job (`lsp-proxy.test.js`) | ✅ |
| **5** | PTY / `:terminal` (seam 2 + resize): wasm `pty_proc_spawn` proxy path; server `node-pty` handler. | `:terminal` echoes; resize propagates (`pty-proxy.test.js`) | ✅ |
| **6** | Demo wiring (visiting the server = the standalone app) + docs. TCP socket proxying left as a documented known gap. | full browser run against a real server | ✅ |

## What shipped

The standalone app is **five IO seams proxied to a server**, plus the server and
the demo wiring that makes "visit the page the server hosts" Just Work:

1. **Transport** (`wasm/proxy-client.js`, `wasm/nvim_io.js`): the engine worker
   opens its own WebSocket to the server and speaks a small framed protocol
   (`hello`/`req`/`res`/`push` + a binary trailer). Under Node the same client runs
   over an in-process transport (the tests). A C-visible js-library lets wasm
   `send-and-await` over the proxy with the calling frame JSPI-suspended.
2. **Filesystem** (seam 1): `__syscall_openat` / `fd_read` / `fd_write` /
   `fstat` / `getdents64` / `close` are `__async`-overridden and, for paths under
   the mount prefix (`/host`), round-trip the server's real disk; every other path
   stays synchronous MEMFS. Server FS handlers are **jailed to `--root`**.
3. **Processes + stdio** (seam 2): an `if(EMSCRIPTEN)` proxy backend in
   `proc_spawn` hands the child's stdio to virtual pollable fds; the server runs
   the real `child_process` and streams bytes back. `:!`, `system()`, `jobstart()`
   all work, cwd jailed to `--root`; children are killed when the connection drops.
4. **LSP**: falls out of (3) — nvim spawns the language server as a stdio job, so a
   server-side LSP "just works" with no LSP-specific code. (`vim.system` /
   `uv_spawn` also rides this via a wasm-only `--wrap=uv_spawn`.)
5. **PTY / `:terminal`** (seam 2 + resize): a `pty_proc_spawn` proxy path backed by
   the server's `node-pty`; `pty.data`/`pty.exit` pushes + a `pty.resize` control
   message. ptys are killed when the connection drops.

**The server** (`wasm/server/server.js`) serves the static bundle over HTTP AND
accepts the proxy WebSocket at `/proxy`. It binds `127.0.0.1` only, takes
`--port`/`--root`, and jails both the FS proxy and child-process cwd to `--root`.

**The demo wiring** (phase 6): when served *by* `server.js`, the page loads a
generated `/proxy-config.js` that sets `window.__NVIM_PROXY = { url, mount, root }`
(the `url` derived from the request Host header, so it tracks localhost /
127.0.0.1 / a forwarded port). `app.js` opts into `create({ proxy })` when that
global is present and chdir/opens the mount so the user lands in the server's
files; when it's absent (the plain `serve.js` static demo, or the library used
without `proxy`) the no-proxy path is byte-for-byte unchanged.

### TCP sockets (shipped — the sixth seam)

Outbound **TCP connections + DNS** are now proxied too, over the same transport.
`socket.c` (`sockconnect('tcp', …)`, `:%!nc`-style channels) AND luv/`vim.uv.tcp`
both funnel through libuv's `uv_tcp_connect` + `uv_getaddrinfo`, so a wasm-only
linker `--wrap` of those (plus `uv_freeaddrinfo`) — mirroring the shipped
`--wrap=uv_spawn` — runs the real connect + lookup on the server:

- `__wrap_uv_tcp_connect` backs the `uv_tcp_t` with the **same MEMFS-backed
  virtual pollable fd** the spawn-stdio proxy uses (`uv_tcp_open(handle, fd)`
  accepts it — no real socket, no `socketpair`), fires `sock.connect{host,port}`
  async, and the server's `sock.connect_ok`/`sock.connect_err` push drives the
  libuv connect callback. Bytes then ride the fd: `sock.data` push → fd queue;
  nvim `uv_write` → `sock.write`; close → `sock.close`.
- `__wrap_uv_getaddrinfo` handles BOTH the **sync** form (`socket.c`, `cb==NULL`
  — JSPI-suspends for the server round-trip, then synthesizes a heap `addrinfo`)
  and the **async** luv form (`cb!=NULL` — fires the cb later). `--wrap=uv_freeaddrinfo`
  frees our synthesized `addrinfo` (recognized by a sentinel).
- **Deferred-callback drain (the JSPI subtlety):** the libuv connect/getaddrinfo
  callbacks re-enter the event loop and can hit the suspending `__syscall_poll`,
  so they MUST run on the engine's main (suspendable) frame — not a plain
  `ccall` from a macrotask (which aborts with "suspend without
  `WebAssembly.promising`"). The JS half therefore only ENQUEUES the result into
  C and wakes the poll; a `uv_check` registered on the loop drains the queue and
  fires the cbs INSIDE `uv_run`. (Also load-bearing: the wrap clears
  `UV_HANDLE_TCP_NODELAY`/`KEEPALIVE` before `uv_tcp_open`, since `socket.c`'s
  `uv_tcp_nodelay(true)` would otherwise make `uv__stream_open` `setsockopt` on
  our non-socket fd and fail the open.)

Server-side, `wasm/server/sock-handlers.js` runs Node `net.connect` +
`dns.lookup`. **Security:** outbound network is the whole point of the seam, so
there is no jail on the *destination* (the server can reach any host it can
route to); the loopback-only bind of the server itself is the load-bearing
protection, exactly as for the proc/PTY seams.

**Unix-domain sockets too.** `sockconnect('pipe', '/path.sock')` and
`vim.uv.new_pipe():connect(path, cb)` / `pipe_connect2` go through libuv's
`uv_pipe_connect` / `uv_pipe_connect2`, wrapped the same way — they reuse the
whole TCP machinery (the same virtual fd, the same connect-result drain, the same
`sock.data`/`write`/`close` routing), just connecting by **path** instead of
host:port (no getaddrinfo, and no nodelay trap since `uv_pipe_open` on a virtual
fd only `fcntl`s). The server's connect handler `net.connect(path)`s a real unix
socket when the request carries `{path}`, else the existing `{host,port}` TCP path.

**Inbound listen/accept too (the seventh seam).** `serverstart('127.0.0.1:0')` /
`serverstart('/path.sock')` and luv `s:bind(); s:listen(backlog, cb); s:accept(c)`
go through libuv's `uv_tcp_bind`/`uv_pipe_bind` → `uv_listen` → (`connection_cb`)
→ `uv_accept`, with `uv_tcp_getsockname` to learn the real bound port. We don't
bind/listen for real in wasm; instead:

- `--wrap=uv_tcp_bind`/`uv_pipe_bind` STORE the addr/path in a per-handle listener
  table (return 0; the real bind happens at listen).
- `--wrap=uv_listen` round-trips the server (JSPI-suspends, like the sync
  getaddrinfo) to `net.createServer().listen(...)`, records the `connection_cb` +
  the listenerId + the **real bound port** the server reports (critical for the
  `:0` random-bind case), `uv__handle_start`s the stream so the loop stays alive,
  and returns 0 / a negative uv errno (EADDRINUSE/EACCES translated from a JS
  category in C, so the value is the right compile-time `UV_*`).
- Each incoming connection: the server `socket.pause()`s it (so no bytes are lost
  before accept) and pushes `sock.incoming{listenerId, connId}`; JS queues the
  connId on the listener and enqueues a connection event into the SAME `uv_check`
  ring the connect path uses; the drain fires `connection_cb(stream, 0)` INSIDE
  `uv_run`.
- `--wrap=uv_accept` (synchronous) pops the next pending connId onto a fresh
  virtual fd, `uv_tcp_open`/`uv_pipe_open`s the client handle (clearing
  `TCP_NODELAY`/`KEEPALIVE` first — the same non-socket setsockopt trap), maps
  fd↔connId, and tells the server `sock.accept{connId}` to attach data handlers +
  `resume()`. From there the accepted socket reuses the WHOLE connected-socket
  path (`sock.data`/`write`/`close`).
- `--wrap=uv_tcp_getsockname` fills the sockaddr from the stored bound host:port
  for our listeners, so `v:servername` / luv `getsockname` report the real port.
- `--wrap=uv_close` is a transparent pass-through for every handle EXCEPT our
  listeners, which it closes server-side (`sock.listen_close`) first. Listeners +
  their accepted sockets are also reaped when the ws disconnects.

**Still not done / caveats (follow-ups):**

- **IPv6** is carried but the synthesized sync `addrinfo` is IPv4-shaped (the
  proxy routes by host:port, so the literal IP is advisory — the server resolves
  the real address). Async vs sync getaddrinfo are both handled.
- **nvim's default startup `serverstart`** (its `$NVIM` pipe at
  `$XDG_RUNTIME_DIR/nvim.<pid>.0`) now routes to the proxy and typically fails
  cleanly (e.g. `EROFS`/`EACCES` on the server's FS) — exactly as it failed before
  (ENOSYS, no server) and harmlessly, since the wasm engine is driven over its
  embed channel (fd 0/1), not this socket. An explicit `serverstart('host:port')`
  / `serverstart('/writable.sock')` works.
- **Abstract-namespace** unix sockets aren't a thing the Node server connects;
  paths are NUL-terminated. listen/accept beyond stream sockets (datagram) is out
  of scope.

## De-risking spikes (done)

Before committing to the phases, the two hardest mechanisms above were proven with
throwaway wasm built under node v26 (`emcc 3.1.69`). Both passed:

- **Seam 1**: an `__async`-marked `__syscall_openat`/`fd_read`/`__syscall_fstat64`
  override served a `/host/*` file whose bytes arrived only on a later macrotask;
  the C frame suspended via JSPI and resumed with correct bytes, while the MEMFS
  sync path was unaffected.
- **Seam 2**: a virtual MEMFS-backed fd with queue-backed pollable `stream_ops` +
  a `stream.tty` marker was accepted by `uv_pipe_open(fd)` + `uv_read_start`;
  libuv's posix-poll backend delivered three async-pushed chunks in order then
  EOF, `poll()` JSPI-suspending between them, and `uv_write` reached the write op.

The exact build commands, js-library overrides, and verbatim output are recorded
in the spike artifacts; the findings (the `fd_read`-not-`__syscall_read` seam, the
varargs-priming requirement, the `stream.tty` requirement, the
`uv_pipe_open`-accepts-any-fd result) are folded into the seam descriptions above.

## Building blocks to reuse (don't re-derive)

- `__syscall_poll` async/JSPI suspension + macrotask-paced wake (`nvim_io.js`).
- `applyChannelOps`: queue-backed, pollable virtual-fd `stream_ops` with a
  `stream.tty` marker — the template for both the proxy-fd table and (loosely)
  the FS overrides' fd bookkeeping.
- The engine-worker init message (`engine-worker.js`) and the `__nvim*` globals
  (`pre.js`) — the seam to carry the proxy connection's config (server URL,
  mount prefix, jail root) into the worker.
- `serve.js` (the static dev server) — `server.js` extends this: same static
  serving, plus the WebSocket endpoint and the IO handlers.
```
