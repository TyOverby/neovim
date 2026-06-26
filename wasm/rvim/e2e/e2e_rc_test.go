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

// TestBrowserRCRemote: `--rc remote` points the in-browser nvim's $HOME at the IO
// host's home dir via the mount, so nvim loads the host's config THROUGH the proxy
// (proving the rc-from-host feature end to end). The "host" here is the in-process
// server; a fake home under --root holds a minimal, plugin-free init.lua.
func TestBrowserRCRemote(t *testing.T) {
	bundle := bundleDir(t)
	if _, err := chromeFound(); err != nil {
		t.Skip("no Chrome/Chromium on PATH; skipping browser e2e")
	}

	root := t.TempDir()
	home := filepath.Join(root, "home", "tester")
	cfgDir := filepath.Join(home, ".config", "nvim")
	if err := os.MkdirAll(cfgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(cfgDir, "init.lua"), "vim.g.rvim_rc_loaded = 'from-remote'\n")
	t.Setenv("HOME", home) // serverHome() honours $HOME (os.UserHomeDir)

	ctx := bootRCServer(t, bundle, server.Config{
		Root: root, Port: 0, Mount: "/host",
		Assets: server.NewAssetServer(os.DirFS(bundle)), ProxyConfig: true, RC: "remote",
	})

	if got := evalRPC(t, ctx, `window.nvim.request('nvim_eval', ['$HOME'])`); got != "/host/home/tester" {
		t.Fatalf("$HOME = %q, want /host/home/tester (rc remote should redirect HOME to the host home via the mount)", got)
	}
	if got := evalRPC(t, ctx, `window.nvim.request('nvim_eval', ['get(g:, "rvim_rc_loaded", "")'])`); got != "from-remote" {
		t.Fatalf("g:rvim_rc_loaded = %q, want from-remote (the host's init.lua did not load through the proxy)", got)
	}
}

// TestBrowserRCLocal: `--rc local` seeds the app-server's own ~/.config/nvim into
// the browser MEMFS (config dir only), loaded with $HOME staying in MEMFS.
func TestBrowserRCLocal(t *testing.T) {
	bundle := bundleDir(t)
	if _, err := chromeFound(); err != nil {
		t.Skip("no Chrome/Chromium on PATH; skipping browser e2e")
	}

	appHome := t.TempDir() // the app-server's own home (NOT under the jail root)
	cfgDir := filepath.Join(appHome, ".config", "nvim")
	if err := os.MkdirAll(cfgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(cfgDir, "init.lua"), "vim.g.rvim_rc_loaded = 'from-local'\n")
	t.Setenv("HOME", appHome)

	ctx := bootRCServer(t, bundle, server.Config{
		Root: t.TempDir(), Port: 0, Mount: "/host",
		Assets: server.NewAssetServer(os.DirFS(bundle)), ProxyConfig: true, RC: "local",
	})

	// $HOME stays in MEMFS for local (the seed lands at /root/.config/nvim).
	if got := evalRPC(t, ctx, `window.nvim.request('nvim_eval', ['$HOME'])`); got != "/root" {
		t.Fatalf("$HOME = %q, want /root (rc local must not redirect HOME)", got)
	}
	if got := evalRPC(t, ctx, `window.nvim.request('nvim_eval', ['get(g:, "rvim_rc_loaded", "")'])`); got != "from-local" {
		t.Fatalf("g:rvim_rc_loaded = %q, want from-local (the seeded config did not load)", got)
	}
}

// bootRCServer starts an in-process server, opens the page in headless Chrome, and
// waits for the engine to attach and the proxy to connect. Returns the browser ctx.
func bootRCServer(t *testing.T, bundle string, cfg server.Config) context.Context {
	t.Helper()
	srv := server.New(cfg, server.NewRegistry())
	if err := srv.Listen(); err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve() }()
	t.Cleanup(func() { _ = srv.Close(context.Background()) })
	url := "http://" + srv.Addr() + "/"

	ctx, cancel := newChrome(t)
	t.Cleanup(cancel)
	ctx, cancelT := context.WithTimeout(ctx, 90*time.Second)
	t.Cleanup(cancelT)

	if err := chromedp.Run(ctx,
		chromedp.Navigate(url),
		chromedp.Poll(`!!window.nvim && /attached/.test((document.getElementById('status')||{}).textContent||"")`,
			nil, chromedp.WithPollingTimeout(60*time.Second)),
		chromedp.Poll(`/proxy connected/.test((document.getElementById('status')||{}).textContent||"")`,
			nil, chromedp.WithPollingTimeout(20*time.Second)),
	); err != nil {
		t.Fatalf("engine boot / proxy connect: %v", err)
	}
	return ctx
}
