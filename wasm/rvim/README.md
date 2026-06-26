# rvim — the stage-5 Go server + conformance harness

This is the Go side of stage 5 (see `../stage5.md`): the native, dependency-free
server that productionizes the standalone app into the three-tier `rvim`
architecture. It is verified by a **conformance suite** (protocol-level, in
process) plus a **headless-Chrome e2e** (`e2e/`, the full browser→engine→server
loop). It was developed against a stage-4 Node reference server; that prototype
has since been removed, and the conformance scenarios remain as the spec.

## Layout

```
proxy/         the IO-proxy wire protocol (frame codec; handlers live in server/)
conformance/   the protocol conformance harness (runs in-process vs the Go server)
  client.go      a protocol Client over a transport (WebSocket)
  scenarios.go   the scenario set — every method family (base/fs/proc/sock/pty)
  target.go      the Target abstraction
  gotarget.go    GoTarget — the in-process Go server
cmd/conformance/  runnable suite entry point (summary output)
e2e/           headless-Chrome integration test (separate module; see e2e/README.md)
```

## The conformance model

The scenarios live in the harness, not in any server, and run against any
`Target`. The only target is `GoTarget` (the in-process Go server). The scenarios
are the protocol spec — originally validated against the stage-4 Node reference
(since removed), now the Go server's fast in-process contract test beneath the
browser e2e.

## Running

```sh
go test ./...              # frame codec unit tests + conformance vs the Go server
go run ./cmd/conformance    # same suite, summary output
```

The conformance suite runs entirely in-process against the Go server — no Node, no
network. The browser e2e (`e2e/`) is a separate module; see `e2e/README.md`.

## Building the binary

```sh
go build -o rvim ./cmd/rvim          # ~9.4MB static binary
```

Two ways to serve the browser bundle:

- **`--assets-dir` (dev):** serve the bundle off disk, no rebuild to swap assets.

  ```sh
  ../web/build-site.sh /tmp/rvim-site         # assemble the flat bundle
  ./rvim --assets-dir /tmp/rvim-site --root ~/project --proxy
  ```

- **Embedded (release):** bake the bundle into the binary so it's a single
  self-contained file (no `--assets-dir` needed). The embed is gated behind the
  `embed_assets` build tag, so the default build compiles without a bundle
  present.

  ```sh
  # 1. build the wasm engine first (produces build-wasm/bin/nvim.{js,wasm,data}):
  ../build-deps.sh && ../build-nvim.sh
  # 2. assemble the flat bundle INTO the embed dir (server/site/, gitignored):
  ../web/build-site.sh server/site
  # 3. build with the tag — server/site/ is embedded via //go:embed:
  go build -tags embed_assets -o rvim ./cmd/rvim
  ./rvim --root ~/project --proxy            # serves the baked-in bundle
  ```

  Step 1 is the prerequisite for a *real* bundle: `build-site.sh` needs
  `build-wasm/bin/nvim.{js,wasm,data}`. Without the wasm build there's nothing
  substantive to embed. Cross-compile a release with the usual `GOOS`/`GOARCH`.

> Module cache: this environment's `$HOME/go` is read-only; point the cache at a
> writable dir, e.g. `GOMODCACHE=/tmp/gomodcache go test ./...`. Deps are vendored
> (`vendor/`), so builds are hermetic and need no network.

## Status

- **Phase 1 (done):** frame codec in Go + conformance harness; all scenarios green
  against the Node reference.
- **Phase 2 (done):** the Go `rvim` server skeleton — `server/` (HTTP + `/proxy`
  WebSocket, handler registry, per-connection ctx with Push/State/cleanup,
  hello+version, base ping/echo handlers, 127.0.0.1 bind, `--assets-dir` static
  serving, gated `/proxy-config.js`) and `cmd/rvim`. A `GoTarget` runs the
  in-process Go server through the conformance suite; the `base` scenarios pass
  against it. Layout below gains `server/` and `cmd/rvim/`.
- **Phase 3 (done):** the filesystem proxy (`server/fs.go`) — the Go port of
  `fs-handlers.js`: `fs.open/read/write/close/stat/lstat/readdir/mkdir/unlink/
  rename` with the realpath-prefix jail (`resolveJailed`). `GoTarget` caps now
  include `fs`; the 4 fs scenarios (incl. the jail-escape rejection) pass, plus a
  dedicated jail containment unit test (`..`, absolute, and symlink escapes).
- **Phase 4 (done):** process + PTY proxy (`server/proc.go`, `server/pty.go`,
  shared `server/procutil.go`) — the Go port of `proc-handlers.js` + `pty-handlers.js`
  (PTY via `creack/pty`): `proc.spawn/stdin/stdin_close/kill` with stdout/stderr/
  exit pushes, `pty.spawn/write/resize/kill` with data/exit pushes, the
  mount-aware `resolveCwd` + PATH-backfilling `childEnv`, and per-connection
  child/pty tables killed on disconnect. A `Response.After` hook (runs after the
  response frame) guarantees the `{id}` reaches the client before any push
  referencing it. `GoTarget` caps now `{base, fs, proc, pty}`; all proc/pty
  scenarios pass (clean under `-race`, stable across repeated runs).
- **Phase 5 (done):** socket + DNS proxy (`server/sock.go`) — the Go port of
  `sock-handlers.js`: `sock.connect` (TCP + unix), `sock.write/close`,
  `sock.getaddrinfo`, and inbound `sock.listen/accept/listen_close` with the
  `sock.incoming`/`connect_ok`/`connect_err`/`data`/`closed` pushes; sockets +
  listeners tracked per connection and torn down on disconnect. **`GoTarget` now
  reaches FULL parity with the Node oracle — all 16 conformance scenarios pass
  against the Go server** (clean under `-race`, stable across 10× runs). The Go
  server now implements every IO seam the stage-4 Node server does.
- **Phase 6 (reconnect done; cancel pending):** the ReconnectingProxy
  (`../proxy-reconnect.js`) — a stable facade at `self.__nvimProxy` that delegates
  `request` to the live client (fast-rejecting during an outage so suspended
  syscalls return `-EIO`, never hang), `close()`s the dead client on drop (the
  Spike B fix), preserves the push router across reconnects, and re-dials with
  backoff. Wired into `web/engine-worker.js`; the FS handlers' path fallback makes
  reads/writes survive the fresh-connection state after a reconnect. Verified by
  `web/reconnect.test.js` (real facade + real server + injected mid-flight drop:
  fail-fast, during-outage fail-fast, auto-reconnect, pushes survive). The
  `cancel` frame (abort a long in-flight op without a disconnect) is reserved in
  the protocol but not yet sent/honored — the remaining Phase 6 sub-item.
- **Browser e2e (done):** `e2e/` — a headless-Chrome integration test (separate
  module so chromedp's deps stay out of the production build) that boots the real
  wasm engine against the real in-process Go server and asserts FS read/write,
  `system()` proc spawn, `glob` readdir, and a `:terminal` PTY command all hit the
  server's disk. This is the durable verification that replaces the Node oracle.
  **It caught a real Go-server bug** the conformance suite structurally couldn't:
  per-request goroutine dispatch reordered rapid `pty.write` frames and scrambled
  terminal input — now fixed by in-order dispatch (`server/server.go`; DNS stays
  async via `Response.Deferred`).
- **Phase 7 (done):** the three-tier **SSH-stdio remote**. A transport-agnostic
  `frameRW` (`server/transport.go`) carries the protocol over a WebSocket OR a
  length-prefixed byte stream. `rvim --serve-stdio` runs the io-proxy over
  stdin/stdout (the remote endpoint); `rvim --remote user@host` puts the
  app-server in RELAY mode — it serves the page locally but forwards each `/proxy`
  WebSocket to `ssh -T user@host rvim --serve-stdio --root <remote-root>`, a
  per-connection subprocess that does all the IO jailed on the remote. The relay
  is a pure framing transcode (no decode). Verified by the whole conformance suite
  over the relay (`conformance` `RemoteTarget` — a local `--serve-stdio` subprocess
  stands in for ssh, identical mechanics) AND a browser e2e over the relay
  (`e2e/TestBrowserRemoteRelay`: real engine → app-server relay → subprocess →
  remote disk). A real ssh-to-localhost run needs sshd + a key configured (not in
  this sandbox); the subprocess stand-in exercises the same transport.
- **Phase 8 (`--rc` done):** `--rc remote|local|builtin` selects where the
  in-browser nvim's config/`$HOME` comes from (default `remote` with `--remote`,
  else `builtin`). `remote` redirects `$HOME` to the IO host's home via the mount
  (the hello reports `home`/`homeDir`; `pre.js` sets it before `main()`), so the
  box's config + plugins load live through the proxy. `local` inlines the
  app-server's own `~/.config/nvim` into `/proxy-config.js` and seeds it into MEMFS
  (config dir only). `builtin` is nvim's defaults. Verified by `server` unit tests
  (`rc_test.go`), the conformance base-hello (`home`/`homeDir`), and two browser
  e2e tests (`e2e/e2e_rc_test.go`: remote `$HOME` redirect + host config loaded;
  local seed loaded). The full live two-layer `--site`/`--rc` routing table is
  still future work.
- Later phases: full FS routing table (`--site`/live routing), auth/TLS, Phase-6 `cancel`.

The Go server's implemented capabilities are tracked by `GoTarget{Implemented:
…}` in `conformance/gotarget.go`; each handler phase adds its cap there and the
matching scenarios must pass.
