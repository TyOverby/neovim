# Stage 5 — `rvim`: the productionized standalone app (three-tier + Go)

> **Status: design + spikes (not yet built).** Stage 4 shipped a working
> single-machine standalone app (Node server, FS/proc/PTY/LSP/sockets proxied,
> jailed to `--root`). Stage 5 productionizes it into `rvim` (remote vim): a
> three-tier architecture that **separates the machine serving the web page from
> the machine holding the files**, a native dependency-free server in Go, robust
> reconnect/error handling, and end-to-end browser tests. The two riskiest
> mechanisms are de-risked (see **Spikes**); this doc is the plan to react to
> before any code lands.

Prereq reading: `stage4.md` (the IO-proxy seams, the wire protocol, the
opt-in invariant). Everything here is **additive** and keeps stage 4's binding
constraint: the engine-side JS (`proxy-client.js`, the js-libraries, the C
`--wrap`s) and the embeddable-widget use case stay working unchanged — only the
*server endpoint* and *transports* grow.

---

## 1. Why three tiers

Stage 4 proved the engine can run locally in the browser while its IO runs on a
server. But it assumed the web/WebSocket server and the IO host are the **same
machine**. In practice you often want them split:

- The machine with your files (a dev box, a cluster node, a VM) may **not be
  exposed to the internet** and may have **no TLS certs** — so it can't safely
  host the page itself.
- You still want to reach it from a browser, securely.

The fix is an **intermediary**: a small server you *do* control (in practice,
your laptop on `127.0.0.1`, or a host behind your nginx/Kerberos proxy) that
terminates HTTP/TLS and serves the page, and forwards all IO to the remote host
over SSH.

```
        ┌──────────────────┐
        │ neovim.js client │   (browser: the wasm engine + IO-proxy client)
        └────────┬─────────┘
                 │  http + websocket   (the frame protocol over a WS message)
                 ▼
        ┌────────────────────┐        ssh (stdio)        ┌─────────────┐
        │ rvim  (app/web)    │ ───────────────────────▶  │ rvim        │
        │ serves page,       │   or unix pipe / in-proc  │ --serve-    │
        │ routes IO, FS jail │ ◀───────────────────────  │ stdio       │
        └────────────────────┘    (the same frames)      └─────────────┘
          intermediary host        encrypted hop          remote host (your files)
```

Three transports, **one protocol** (stage 4's frame format, unchanged):

| hop                     | transport            | framing source            |
|-------------------------|----------------------|---------------------------|
| browser ↔ app server    | WebSocket            | WS message boundaries     |
| app server ↔ remote     | SSH stdio (default)  | length-prefix reassembly  |
| app server ↔ remote (local case) | in-process / unix pipe | direct / length-prefix |

When you run `rvim` **on the machine you want to edit**, there is no remote hop:
the io-proxy runs **in-process** (no transport at all), so the local case stays
exactly as simple as stage 4.

---

## 2. One binary, three modes, io-proxy as a library

`rvim` is a single Go binary. The io-proxy (all of stage 4's FS/proc/PTY/socket
handlers, reimplemented in Go) is a **library package**, wired to a transport by
the binary:

- **app-server mode** (`rvim …`): serves the page + WebSocket, owns the FS
  routing table, and either calls the io-proxy library **in-process** (local) or
  forwards frames to a remote over SSH (`--remote`).
- **remote mode** (`rvim --serve-stdio`, internal): the io-proxy library reading
  frames on **stdin** and writing on **stdout**. This is what the app server
  launches via `ssh host rvim --serve-stdio`. It binds no ports.
- the **local case** is just app-server mode driving the io-proxy library
  directly — no `--serve-stdio`, no SSH.

Factoring the io-proxy as a transport-agnostic library is what makes it
**unit-testable without any transport** (drive the package directly) and keeps
the three modes from duplicating handler logic.

Why Go (not packaging the Node server): the stated requirements — *small static
binary, no runtime dependency, easy cross-compilation* — are exactly Node's weak
spots (needs Node installed on the remote; native `node-pty` build). Go gives a
single static binary, `GOOS/GOARCH` cross-compile, `embed.FS` for the web
assets, goroutine-per-stream concurrency, and `creack/pty` to replace node-pty.

---

## 3. The remote transport: SSH stdio

`rvim --remote user@host …` runs `ssh user@host rvim --serve-stdio` and uses the
**ssh process's stdin/stdout as the pipe**. SSH handles encryption, auth, and
host-key verification; the remote io-proxy never binds a port. Spike A confirmed
the frame protocol round-trips over a child process's stdio (mechanically
identical — ssh just adds an encrypted hop in front of the same two pipes),
including 64 KiB binary payloads, interleaved request demux, and prompt failure
on hangup.

- **v1 assumption:** the `rvim` binary is already on the remote's `PATH`. (A
  later nicety: on `command not found`, scp the matching `GOOS/GOARCH` binary
  over the same SSH connection and retry — Go cross-compile makes this cheap.)
- A raw byte pipe (unlike a WebSocket) has no message boundaries, so the read
  side reassembles frames from the `uint32LE` length prefix. Spike A exercises
  exactly this.

---

## 4. Wire protocol: keep the custom frame, add two fields

Keep stage 4's frame (`uint32LE headerLen | headerJSON | payloadBytes?`) — it is
proven against every handler, carries **raw binary trailers** (PTY streams,
large reads) with no base64 bloat, and is **transport-agnostic** (the same frames
ride WebSocket, SSH stdio, unix pipe, and the in-process channel). JSON-RPC would
force base64; msgpack-RPC adds a dep for no gain. Two additions, now that
client / app / remote are **separately-built binaries that can drift**:

- **`version` in the `hello`** — both sides advertise a protocol version and
  refuse / warn loudly on mismatch (Spike A models this).
- **a `cancel` frame** — `{ t:'cancel', id }` aborts an in-flight request. The
  reconnection model needs it (to bound suspended syscalls), and long ops (a big
  `:grep`, a slow LSP request) become abortable. Spike A confirms a cancel aborts
  a slow op promptly instead of waiting it out.
- **`user` in the hello ack** — the io-proxy reports the user it runs as (the
  *remote* user under `--remote`, since the relay forwards the hello to the remote
  `--serve-stdio` process, which answers it). The engine worker defers the engine
  boot until the first hello settles and exports that as `$USER`/`$LOGNAME` before
  `main()` runs, so the in-browser editor's `$USER` matches the host whose files
  it edits — not the standalone `'web'` default. A caller's `create({ env })` still
  wins; a missing/unreachable server falls back to `'web'` (boot proceeds degraded).

The app server is a **protocol participant on both sides** (it terminates frames
to consult the FS routing table — §5), not a blind byte-forwarder.

---

## 5. Filesystem: a two-layer prefix-routing table

> **`--rc` shipped** (the config half). Rather than the full live prefix-routing
> table, `--rc` is implemented via the **already-built `$HOME`/seed seam** (the
> same hello→identity→`pre.js` path the `$USER` work added):
> - **`--rc remote`** (default with `--remote`) — the hello ack reports the IO
>   host's home + its in-editor path (`homeDir`, non-empty only when the home is
>   under `--root`); the engine worker sets `$HOME` to it **before `main()`**, so
>   nvim loads the host's `~/.config/nvim` **and plugins** live through the proxy.
> - **`--rc local`** — `$HOME`/`$USER` are still the host's, but `$HOME/.config/nvim`
>   is **shadowed** to the app-server's own config: the app-server inlines its
>   `~/.config/nvim` into `/proxy-config.js` (`window.__NVIM_RC_FILES`, capped); the
>   engine worker remaps the seed onto the editor-space config dir and sets
>   `__nvimLocalShadow` so `nvim_fs_proxy.js`'s `isHostPath` excludes that subtree
>   (served from MEMFS, not the remote) — a per-prefix local route. Everything else
>   under `$HOME` (shada, data) stays on the host. Config dir only (no plugins).
> - **`--rc builtin`** (default without `--remote`) — no external config; defaults.
>
> So `remote` = live `$HOME` redirect through the existing FS proxy (no new routing
> layer, no relay decode); `local` = a one-shot MEMFS seed from the app-server's own
> disk. The full live two-layer table below (and `--site`) is still future work.

`--site` and `--rc` require the app server to sometimes **serve a file itself**
rather than forward it. Model the whole FS layer as **one prefix-routing table**,
of which site / rc / project are just entries. The routing splits cleanly across
the two machines that *have* a disk:

- **The browser decides bundled-vs-proxied.** "bundled" = the file never leaves
  the browser (MEMFS — the wasm build already ships its own runtime). This is an
  extension of stage 4's existing mount-prefix config, not a rearchitecture.
- **The app server decides local-vs-remote** for everything the browser proxied:
  serve from the intermediary's own disk, or forward to the remote.

So a flag value picks **which layer** owns a prefix:

```
rvim --site bundled   # $VIMRUNTIME from the wasm bundle  (DEFAULT — version-matched)
rvim --site local     # from the app-server machine's installed nvim
rvim --site remote    # from the remote host's installed nvim
rvim --rc   remote     # ~/.config/nvim from the remote (DEFAULT for --remote)
rvim --rc   local      # from the app-server machine
rvim --rc   bundled    # empty / none
```

`--site bundled` is the strong default and the *safe* one: a runtime from a
differently-versioned nvim against this exact wasm engine breaks confusingly, so
`local`/`remote` warn loudly about version skew.

**Coherence rule to document:** there is exactly **one** remote host. `--site` /
`--rc` redirect only *file reads*; all process / PTY / socket IO always targets
the single remote. "rc from local, project on remote" works because plugins read
their *own files* locally but *spawn* on the remote (where the code, LSPs, and
formatters live) — usually exactly what you want.

---

## 6. Error handling & reconnection — the load-bearing contract

Multi-process and now multi-machine, so failure is routine. The contract
(de-risked by Spike B against the real `proxy-client.js`):

> **The browser engine is the only durable state. Every transport and host below
> it is best-effort and reconnectable. On any disconnect: in-flight ops fail
> fast, live handles tear down, then the transport reconnects so the *next* op
> succeeds. No transparent replay.**

Why this and not replay: the engine lives in the browser worker, so a dropped
WebSocket or SSH pipe does **not** kill the editor — buffers, undo, cursor are
intact. What dies is *IO state*. So the honest model is partial degradation, not
session loss: a `:w` during a blip errors, you reconnect, you `:w` again and it
works. Transparent op-replay (idempotency + cross-host replay state) is a tar pit;
skip it.

**The one mechanism this forces us to get right is fail-fast.** A proxied syscall
is a JSPI-suspended promise awaiting a response frame; if the socket dies, that
promise must **reject** so the syscall returns `-EIO` instead of hanging forever.
Two findings make this tractable:

1. **The `-EIO` rejection arm already exists.** Every async syscall override is
   shaped `proxy.request(...).then(onResolve, () => -5 /* -EIO */)` (see
   `nvim_fs_proxy.js` `fd_read`/`fd_write`). When the transport drops and the
   client rejects all pending requests, each suspended syscall settles to `-EIO`.
   Spike B confirms 25 concurrent in-flight ops all settle to `-EIO` in <100 ms,
   no hang.
2. **Use `close()` on drop, not just `onTransportClosed()`** (Spike B finding).
   `onTransportClosed()` rejects *in-flight* requests but leaves the client open,
   so a syscall issued *during* the outage window hangs. The reconnecting wrapper
   must `client.close()` the dropped client (rejects in-flight **and** future
   requests) and route new syscalls to a **fresh** client created for the new
   transport.

The new engine-worker piece is a **ReconnectingProxy** (Spike B models it): owns
the current client, on `ws.onclose` calls `close()` + re-dials with backoff, and
`proxy()` always returns the current live client. Subtleties to document:

- **WebSocket reconnect is cheap** (engine + app server survive; only the wire
  blipped). **SSH reconnect is destructive** — the remote `--serve-stdio` is a
  *fresh process*, so all remote fds / jobs / listeners are gone; it tears down
  more, but follows the same rule.
- **Idempotency:** reads/writes/stats are safe to fail-and-retry. Spawns and
  socket-connects are **not** (retry = double-spawn), so on a drop they tear down
  and are never auto-retried — the user re-triggers if they want them.
- **Unsaved-buffer safety net** (since a permanently-dead remote means you can't
  `:w` anywhere, but the buffer is safe in the browser): allow `:w` to a
  bundled/MEMFS path, a "download buffer" command, and/or persist dirty buffers
  to IndexedDB so a tab-close doesn't lose work. Not v1-critical; it's the
  difference between "annoying" and "lost my work."

### 6.1 Durable `:terminal` — the session-host daemon (Phase 7)

"Live handles tear down" is right for idempotent IO (retry) and one-shot spawns
(re-run), but **wrong for a `:terminal`**: it is long-lived stateful session — a
running shell, an `ssh`/`top`/`vim` inside it, scrollback, cwd, history — that the
user can't just "re-trigger." So PTYs get a deliberate exception.

`rvim --session-host` is a persistent per-user daemon on the IO host (the remote,
under `--remote`) listening on a unix socket (`$XDG_RUNTIME_DIR/rvim/host.sock`,
singleton via flock, auto-spawned `ssh-agent`-style and detached with `setsid`).
It owns the PTY children **outside any single connection**, keyed by a stable
per-tab session id the browser mints (carried in `?session=` on the `/proxy` URL;
the app-server threads it to `--serve-stdio --session <key>`). Per-connection
io-proxies *attach* by key and delegate `pty.*` to the daemon (fs/proc/sock stay
local/per-connection — the base contract is correct for them). On disconnect the
daemon **keeps the shells running** and buffers their output; on reattach it
replays the buffered output so the terminal catches up. PTYs are reaped only on an
idle TTL or explicit kill.

Because the daemon lives on the IO host, terminals survive **app-server restart**
and **hard SSH death** while the browser tab is alive — not just a wire blip.

### 6.2 Cold restore — `:mksession` rehydration (Phase 8)

The *cold* case — the browser/nvim itself gone (laptop reboot, closed tab) — is
also covered, natively, without tmux. nvim's terminal *screen* is libvterm state
in the browser worker that no daemon can preserve, and a fresh nvim has no
terminal buffers to reattach — but `:mksession` already records the terminals, and
the daemon already keeps the shells alive. The bridge:

- **A stable session id.** The host app mints it and persists it in `localStorage`
  keyed by the project URL (not the worker's ephemeral per-load id), so reopening
  the page reconnects to the same daemon session whose shells are still running.
- **Adopt-on-spawn by match.** nvim's terminal pid is the browser-*local* (ephemeral)
  pty id, so persisting the daemon's stable id would need a C bridge. Instead the
  **daemon matches a restore-spawn to a still-running pty by (resolved cwd, argv)**
  and reattaches — replaying its ring so libvterm repaints — else spawns fresh. The
  io-proxy already mediates every `pty.spawn` and resolves cwd, so the match key is
  consistent on both sides; no persisted id, **no C change, no browser-engine
  change, no wasm recompile**.
- **The restore hook.** A runtime-injected replacement for the `term://` restore
  autocmd (only when a proxy is configured) adds `RVIM_ADOPT=1` to the env during a
  `:mksession` restore (`g:SessionLoad`); the io-proxy turns that into `adopt:true`.
  It jobstarts a **list** (argv), not a string — `jobstart(string)` shell-wraps
  (`sh`→`{sh,-c,sh}`) and would never match the original `{sh}`.

So: open a `:terminal`, `:mksession`, close the tab, reopen, `:source` — the
terminal reattaches to its live shell and repaints. (This is what "adopt an
orphaned pty" would have been; it turned out tractable in-core because the restore
path is runtime Lua and the daemon already keeps shells + a ring.) Proven by a
headless-Chrome e2e (`e2e/e2e_durable_term_test.go`). Limit: only as durable as the
daemon's idle TTL and ring cap; a shell idle past the TTL is reaped and respawns
fresh.

- **The reconnect seam is no-duplication + a bounded gap, not exactly-once.**
  Output the io-proxy pulled from the daemon but couldn't push to the browser
  before a hard drop is lost (the daemon counts it delivered). For a terminal this
  is self-healing (the next redraw repaints). Closing it to exactly-once needs a
  browser byte-offset ack on (re)attach so the daemon replays from the last
  rendered byte — a future hardening, not v1.
- **Bounds:** per-PTY replay buffer capped (drop oldest — terminal tail is what
  matters); session idle-TTL before reap; daemon is single-user (loopback / unix
  socket 0700, same trust model as the bind).

---

## 7. Security & auth

- **App server binds `127.0.0.1` by default** (as stage 4). This covers the
  common prod path too: behind an nginx reverse proxy doing Kerberos auth, nginx
  talks to `rvim` on loopback.
- **Binding beyond loopback requires a token + TLS** — a deliberate, guarded
  mode, never the default. Without it, anyone who can reach the port gets a shell
  on the remote.
- **The remote host is never internet-exposed** — it is reached only via SSH from
  the app server, so **the SSH hop is its authentication**. This is a clean
  property worth stating: there is no second auth surface to secure on the remote.
- FS jail (`--root`) and child-process cwd jail carry over from stage 4.

---

## 8. CLI

```
rvim [neovim args]                    # app+web server on this box; io-proxy in-process;
                                      # prints (and opens) the URL. Local = stage-4 parity.
rvim --remote user@host [nvim args]   # app server here; launches `rvim --serve-stdio` on
                                      # host over ssh; all IO runs on host.
rvim --serve-stdio                    # (internal) remote io-proxy over stdin/stdout.

  --site   bundled|local|remote   (default bundled)   # §5 routing
  --rc     bundled|local|remote   (default: remote when --remote, else local)
  --root   DIR                    # FS jail (default: cwd locally / remote home)
  --port   N                      # app-server port (default 8001)
  --bind   ADDR                   # default 127.0.0.1; non-loopback ⇒ requires --token + TLS
  --assets-dir DIR                # serve web assets off disk (dev); else embedded (release)
  --no-open                       # don't auto-launch the browser
```

`neovim args` pass through to the in-browser `nvim --embed` launch (as today).
`--assets-dir` keeps the dev binary lean (the embedded `nvim.wasm` + `.data` are
tens of MB); release builds `embed.FS` them so the binary is self-contained.

---

## 9. The Go port — de-risking against a reference oracle

Only the **server endpoint** moves to Go; the entire engine side (the wasm
build, `proxy-client.js`, the js-libraries, the C `--wrap`s) is unchanged. So
this is a **port against a known spec**, not greenfield. To keep it low-risk:

1. **The stage-4 Node server is the reference oracle** during the port — it
   already passes the full suite, so it defines correct frame behavior.
2. **A language-neutral conformance suite**: golden frame transcripts ("send
   these frames → expect these responses / FS effects") that **both** the Node
   reference and the new Go server must pass. This protects the protocol during
   the port and forever after.
3. Port handler families one at a time (FS → proc → PTY → sockets), each gated
   behind the conformance suite, with the Node server available for differential
   testing until Go reaches parity.

What's lost and must be replaced: the in-process JS test harness that drove the
Node handlers directly. Replaced by (a) the conformance suite and (b) Go unit
tests driving the io-proxy package directly (no transport).

---

## 10. Testing

Three layers, the top one being the most important:

- **Go unit tests** — drive the io-proxy **library** directly (no transport),
  with hermetic temp dirs, so real production code paths (FS jail, spawn, pty
  resize/signals/exit codes via `creack/pty`) are covered without messing up the
  test host.
- **Protocol conformance** — the golden-transcript suite (§9), run against both
  servers.
- **End-to-end browser tests via `chromedp`** — a single Go test binary that
  launches the app server, drives **headless Chrome**, types into the editor, and
  asserts on **real FS/proc effects** in a hermetic environment. The same
  `chromedp` harness backs an **agent-facing binary** so an AI agent (or a human)
  can watch the live browser — reusing one harness for tests and inspection.

Test the multi-host path explicitly:

- **Pipe/subprocess remote** for fast hermetic e2e (drive `rvim --serve-stdio`
  over a pipe — what Spike A does in miniature).
- **At least one real ssh-to-localhost** test (sshd + a throwaway key in CI) so
  the actual SSH transport is exercised, not mocked.
- **Fault injection** (the part most likely to regress and hardest to catch by
  hand): kill the WebSocket mid-`:w` and assert the op fails fast (a hard timeout
  asserting **no hang**) and a subsequent `:w` succeeds after reconnect; kill the
  SSH mid-session and assert teardown + reconnect. Spikes A and B are the unit-
  level seeds of these.

---

## Spikes (done — both green)

- **Spike A — SSH-stdio framing** (`wasm/spikes/stage5-ssh-stdio`, Go): the stage-4 frame
  protocol round-trips over a child process's stdin/stdout (== `ssh host rvim
  --serve-stdio`). Confirms Go encode/decode matching the JS wire format
  byte-for-byte, stream reassembly from the length prefix, 64 KiB binary payload
  intact, interleaved-request demux by id, the new `cancel` frame aborting a slow
  op, and remote-hangup failing in-flight ops fast (no hang). **5/5.**
- **Spike B — fail-fast + reconnect** (`wasm/spikes/stage5-reconnect`, Node, drives the REAL
  `proxy-client.js`): 25 concurrent in-flight "syscalls" all settle to `-EIO` in
  <100 ms on disconnect (no hang); a syscall issued during the outage also fails
  fast; after automatic reconnect new ops succeed against a fresh client.
  **Design finding:** use `client.close()` on drop (not just
  `onTransportClosed()`), else a request issued during the outage window hangs on
  the stale-but-open client. **8/8.**

Both confirm the load-bearing claims: the SSH-stdio transport is just the proven
frame protocol over different pipes, and the reconnection contract works against
the unmodified engine-side client because the `-EIO` rejection arm already exists.

---

## Phase plan

Cadence (same as stage 4): one focused effort per phase, **independently verify**
(Go unit + conformance + real browser via chromedp), commit between, **don't
push**.

| # | Phase | Deliverable | Risk |
|---|-------|-------------|------|
| 0 | Design (this doc) + spikes | stage5.md, Spike A/B green | done |
| 1 | Conformance harness | golden frame transcripts; Node reference passes | low |
| 2 | Go skeleton | `rvim` binary, `embed.FS` assets, WS + static serving, `--assets-dir`, hello+`version`; serves the existing wasm page (no proxy yet) | low |
| 3 | Go io-proxy: FS | FS handler family in Go (jailed); passes conformance + a chromedp `:e`/`:w` test | med |
| 4 | Go io-proxy: proc + PTY | spawn/`creack/pty`; `childEnv`/`resolveCwd` parity; chromedp `:!`/`:terminal` | med |
| 5 | Go io-proxy: sockets | tcp/unix/dns + inbound listen/accept; conformance | med |
| 6 | `cancel` + ReconnectingProxy | `cancel` frame end-to-end; engine-worker reconnect wrapper (`close()`-on-drop); fault-injection tests | **high** |
| 7 | SSH-stdio remote (**done**) | `--remote`, `--serve-stdio`; relay = framing transcode; conformance + browser e2e over a subprocess stand-in; assume-on-PATH | med |
| 8 | FS routing table | `--rc remote/local/builtin` **done** (via the `$HOME`/seed seam — §5); full two-layer `--site`/live-`--rc` table + version-skew warnings still future | med |
| 9 | Auth/TLS guard + polish | `--bind`/`--token`/TLS gate; `--no-open`; unsaved-buffer safety net; docs | med |
| D | Durable `:terminal` (**done**) | `rvim --session-host` daemon (§6.1); per-tab `?session=`; `pty.*` delegated + reattach replays buffered output; survives app-server restart / SSH death | med |
| E | Cold restore (**done**) | `:mksession` rehydration (§6.2); stable localStorage session id + daemon adopt-on-spawn by (cwd,argv); close tab → reopen → `:source` reattaches live shells; no C change / no wasm recompile | med |

Risk-ordered, the two things to watch are **Phase 6** (the reconnect/cancel
machine — fault injection must prove no-hang) and the **port itself** staying
honest against the conformance suite. Both are pre-de-risked by the spikes.

---

## Open questions / deferred

- **Binary upload to the remote** (scp on `command not found`) — deferred;
  v1 assumes on-PATH.
- **Latency on chatty ops** — keystrokes are local (instant), but `:e bigfile`,
  directory walks, and LSP/fuzzy-finders that stat thousands of files now eat a
  round-trip per op across two hops. JSPI keeps it correct; the routing layer is
  the natural future home for readdir+stat coalescing / attribute caching. Not
  v1-blocking.
- **IPv6 / abstract-namespace / datagram sockets** — carried over from stage 4's
  known gaps.
- **Multi-remote** — explicitly out of scope; the model is one remote host.
