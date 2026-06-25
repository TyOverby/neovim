package e2e

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/chromedp/chromedp"

	"rvim/server"
)

// TestBrowserDurableTerminalRehydrate is the end-to-end proof of cold-restore
// (:mksession) rehydration: open a :terminal, drive a unique marker into its shell,
// :mksession, RELOAD the page (a fresh engine — same localStorage session id), then
// :source the session. The terminal must come back showing the marker, which only
// an ADOPTED (reattached) shell's output ring can contain — a respawned fresh shell
// would not. Exercises the whole stack: app.js term:// adopt hook + ?session= +
// io-proxy RVIM_ADOPT marker + session-host daemon (cwd,argv) match + ring repaint.
func TestBrowserDurableTerminalRehydrate(t *testing.T) {
	bundle := bundleDir(t) // skips if the wasm engine isn't built
	if _, err := chromeFound(); err != nil {
		t.Skip("no Chrome/Chromium on PATH")
	}

	root := t.TempDir()
	sock := filepath.Join(t.TempDir(), "host.sock")
	host := server.NewSessionHost()
	go func() { _ = host.Serve(sock) }()
	t.Cleanup(host.Close)
	waitForFile(t, sock)

	// App-server in LOCAL proxy mode, pointed at the in-process session-host daemon.
	srv := server.New(server.Config{
		Root:        root,
		Port:        0,
		Assets:      server.NewAssetServer(os.DirFS(bundle)),
		ProxyConfig: true,
		DaemonSock:  sock,
	}, server.NewRegistry())
	if err := srv.Listen(); err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve() }()
	defer srv.Close(context.Background())
	url := "http://" + srv.Addr() + "/"

	ctx, cancel := newChrome(t)
	defer cancel()
	ctx, cancelT := context.WithTimeout(ctx, 150*time.Second)
	defer cancelT()

	// --- First session: open a terminal, drive a marker, save the session. ---
	connectPage(t, ctx, url)

	const marker = "COLD-MARKER-42"
	evalRPC(t, ctx, `window.nvim.request('nvim_command', ['terminal'])`)
	// Drive the marker into the shell via the pty's stdin (deterministic — no
	// terminal-mode keypress fiddliness). The terminal buffer is current after
	// :terminal, so b:terminal_job_id resolves.
	waitTrue(t, ctx, `(window.nvim.request('nvim_eval',['exists("b:terminal_job_id")']).then(r=>r===1))`)
	evalRPC(t, ctx, `window.nvim.request('nvim_eval', ['chansend(b:terminal_job_id, "echo `+marker+`\n")'])`)
	waitGridContains(t, ctx, marker, "marker did not appear in the original terminal")

	sidBefore := readSessionID(t, ctx)

	// Save the session onto the server's disk (via the /host mount).
	evalRPC(t, ctx, `window.nvim.request('nvim_command', ['mksession! /host/Session.vim'])`)
	time.Sleep(400 * time.Millisecond)
	assertFileExists(t, filepath.Join(root, "Session.vim"))

	// --- Reload: a FRESH engine, same origin -> same localStorage session id. ---
	if err := chromedp.Run(ctx, chromedp.Navigate(url)); err != nil {
		t.Fatalf("reload: %v", err)
	}
	connectPage(t, ctx, url)
	if sidAfter := readSessionID(t, ctx); sidAfter != sidBefore {
		t.Fatalf("session id not stable across reload: %q -> %q (cold rehydration relies on this)", sidBefore, sidAfter)
	}

	// The fresh engine has no terminal yet; sourcing the session recreates it, and
	// the adopt hook reattaches it to the still-running shell on the daemon — so the
	// marker the ORIGINAL shell printed repaints (a respawned fresh shell could not
	// show it). On failure, the daemon snapshot tells whether it respawned.
	evalRPC(t, ctx, `window.nvim.request('nvim_command', ['source /host/Session.vim'])`)
	defer func() {
		if t.Failed() {
			t.Logf("session-host state:\n%s", host.DebugSummary())
		}
	}()
	waitGridContains(t, ctx, marker,
		"terminal did not rehydrate with the live shell's output (adopt failed — respawned fresh?)")
}

func readSessionID(t *testing.T, ctx context.Context) string {
	t.Helper()
	return evalRPC(t, ctx, `Promise.resolve(localStorage.getItem('rvim:session:'+location.origin+location.pathname))`)
}

// connectPage navigates (if needed) and waits for the engine to attach and the
// proxy to connect.
func connectPage(t *testing.T, ctx context.Context, url string) {
	t.Helper()
	if err := chromedp.Run(ctx,
		chromedp.Navigate(url),
		chromedp.Poll(`!!window.nvim && /attached/.test((document.getElementById('status')||{}).textContent||"")`,
			nil, chromedp.WithPollingTimeout(60*time.Second)),
		chromedp.Poll(`/proxy connected/.test((document.getElementById('status')||{}).textContent||"")`,
			nil, chromedp.WithPollingTimeout(30*time.Second)),
	); err != nil {
		t.Fatalf("engine boot / proxy connect: %v", err)
	}
}

// waitGridContains polls the rendered grid until it contains substr.
func waitGridContains(t *testing.T, ctx context.Context, substr, failMsg string) {
	t.Helper()
	expr := `(window.nvim.gridText && window.nvim.gridText().indexOf(` + jsString(substr) + `) >= 0)`
	if err := chromedp.Run(ctx, chromedp.Poll(expr, nil, chromedp.WithPollingTimeout(30*time.Second))); err != nil {
		t.Fatalf("%s (substr %q): %v", failMsg, substr, err)
	}
}

// waitTrue polls until the JS expression (a boolean-yielding Promise) resolves true.
func waitTrue(t *testing.T, ctx context.Context, promiseExpr string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		var ok bool
		wrapped := `(` + promiseExpr + `).catch(()=>false)`
		if err := chromedp.Run(ctx, chromedp.Evaluate(wrapped, &ok, awaitPromise)); err == nil && ok {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("condition not met: %s", promiseExpr)
}

func jsString(s string) string {
	return "\"" + s + "\""
}

func waitForFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("file never appeared: %s", path)
}

func assertFileExists(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected file %s: %v", path, err)
	}
}
