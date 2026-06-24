# rvim — the stage-5 Go server + conformance harness

This is the Go side of stage 5 (see `../stage5.md`): the native, dependency-free
server that productionizes the stage-4 standalone app into the three-tier `rvim`
architecture. It is built phase by phase against a **conformance suite** so the
Go server is verified to behave identically to the stage-4 Node reference.

## Layout

```
proxy/         the IO-proxy wire protocol (frame codec; handlers in later phases)
conformance/   the language-neutral protocol conformance harness
  client.go      a protocol Client over a transport (WebSocket)
  scenarios.go   the scenario set — every method family (base/fs/proc/sock/pty)
  target.go      Target abstraction; NodeTarget runs the stage-4 reference oracle
  node-target.js Node launcher (stage-4 server on an ephemeral port)
cmd/conformance/  runnable suite entry point (summary output)
```

## The conformance model

The scenarios live in the harness, not in any server, and run against any
`Target`. Today the only target is `NodeTarget` — the **stage-4 Node server is
the reference oracle**. As the Go server is built (Phases 3–5), a `GoTarget` is
added and must pass the *same* scenarios; the suite becomes the differential
check that keeps the port honest.

## Running

```sh
# requires `node` on PATH and the server's npm deps installed
#   ( cd ../web && npm install )    # ws + node-pty
go test ./...                       # frame codec unit tests + conformance vs Node
go run ./cmd/conformance             # same suite, summary output
```

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
- Later phases: sockets, `cancel` + reconnect, SSH-stdio remote, FS routing,
  auth/TLS.

The Go server's implemented capabilities are tracked by `GoTarget{Implemented:
…}` in `conformance/gotarget.go`; each handler phase adds its cap there and the
matching scenarios must pass.
