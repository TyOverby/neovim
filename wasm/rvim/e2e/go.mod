// Separate module: the browser e2e test pulls in chromedp's large dependency
// tree, which must NOT touch the production `rvim` module (kept lean + vendored
// for a hermetic, dependency-free binary). `replace rvim => ../` builds the
// server from source. This module is dev/CI tooling — not shipped — so it is not
// vendored; `go test` here fetches chromedp from the module cache/network.
module rvim-e2e

go 1.24

require (
	github.com/chromedp/cdproto v0.0.0-20250724212937-08a3db8b4327
	github.com/chromedp/chromedp v0.14.2
	rvim v0.0.0
)

require (
	github.com/chromedp/sysutil v1.1.0 // indirect
	github.com/coder/websocket v1.8.15 // indirect
	github.com/creack/pty v1.1.24 // indirect
	github.com/go-json-experiment/json v0.0.0-20250725192818-e39067aee2d2 // indirect
	github.com/gobwas/httphead v0.1.0 // indirect
	github.com/gobwas/pool v0.2.1 // indirect
	github.com/gobwas/ws v1.4.0 // indirect
	golang.org/x/sys v0.34.0 // indirect
)

replace rvim => ../
