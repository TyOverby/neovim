# rvim browser e2e

The headless-Chrome integration test: it boots the **real** wasm Neovim engine in
headless Chrome against the **real** in-process Go server (`--proxy`) and asserts
real filesystem + process effects on the server's disk. This is the durable
verification that the full **browser → wasm engine → Go server** loop works — the
safety net that replaces the Node conformance oracle once the Node prototype is
removed.

It is a **separate Go module** (`go.mod`, `replace rvim => ../`) on purpose: it
pulls in chromedp's large dependency tree, which must never touch the lean,
vendored production `rvim` module. This module is dev/CI tooling, not shipped, so
it is not vendored.

## Running

```sh
cd wasm/rvim/e2e
go test -v                       # builds the bundle itself if the wasm engine is built
# or point at a prebuilt bundle:
RVIM_BUNDLE=/path/to/build-site-output go test -v
```

Prerequisites (the test **skips**, not fails, when missing):
- a Chrome/Chromium binary on PATH (Chrome ≥ 137 for JSPI — verified on 149);
- a built browser bundle: either `RVIM_BUNDLE=<build-site.sh output>`, or the wasm
  engine built (`build-wasm/bin/nvim.js`, via `wasm/build-nvim.sh`) so the test can
  run `wasm/web/build-site.sh` itself into a temp dir.

## What it covers

| subtest | exercises |
|---|---|
| fs read | the editor reads a server-only file (`readfile`) |
| fs write (writefile) | `fs.open`+`write`+`close` land bytes on the server disk |
| fs write (editor :w!) | the real editor save flow lands on the server disk |
| proc spawn (system) | `system()` runs a real process on the server |
| fs readdir (glob) | `glob` sees the server's files |
| pty terminal | `:terminal` runs a real shell; a typed command creates a file |

## Notes / findings

- **Keystroke ordering.** The pty-terminal case caught a real Go-server bug: a
  per-request goroutine dispatch reordered rapid `pty.write` frames, scrambling
  terminal input (`touch by-terminal.txt` → `tour-clmihtnea`). Fixed by dispatching
  frames in order (see `server/server.go`); this class of bug is invisible to the
  conformance suite, which waits for each response before sending the next.
- **`:w` on a brand-new buffer** trips nvim's `'readonly'` diagnostic (`E45`) — a
  pre-existing engine-side papercut (it affects the Node server too), not a proxy
  fault; `:w!` writes fine. Worth fixing engine-side later (the new-file
  write-access check via the FS proxy).
