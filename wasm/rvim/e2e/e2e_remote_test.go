package e2e

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/chromedp/chromedp"

	"rvim/server"
)

// TestBrowserRemoteRelay drives the REAL browser engine through the THREE-TIER
// path: browser -> app-server (relay mode) -> SSH-stdio -> `rvim --serve-stdio`
// subprocess, which performs the IO jailed to its own --root. A local subprocess
// stands in for `ssh host …` (identical mechanics). Asserts FS + proc effects land
// on the remote's disk.
func TestBrowserRemoteRelay(t *testing.T) {
	bundle := bundleDir(t)
	if _, err := chromeFound(); err != nil {
		t.Skip("no Chrome/Chromium on PATH")
	}
	bin := buildRvimBinary(t)

	remoteRoot := t.TempDir() // the "remote" host's project dir
	writeFile(t, filepath.Join(remoteRoot, "preexisting.txt"), "on the remote\n")

	// App-server in RELAY mode: every /proxy connection runs the rvim subprocess
	// over stdio (in place of ssh). ProxyConfig so the page connects back.
	srv := server.New(server.Config{
		Root:          remoteRoot,
		Port:          0,
		Assets:        server.NewAssetServer(os.DirFS(bundle)),
		ProxyConfig:   true,
		RemoteCommand: []string{bin, "--serve-stdio", "--root", remoteRoot},
	}, server.NewRegistry())
	if err := srv.Listen(); err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve() }()
	defer srv.Close(context.Background())
	url := "http://" + srv.Addr() + "/"

	ctx, cancel := newChrome(t)
	defer cancel()
	ctx, cancelT := context.WithTimeout(ctx, 90*time.Second)
	defer cancelT()

	if err := chromedp.Run(ctx,
		chromedp.Navigate(url),
		chromedp.Poll(`!!window.nvim && /attached/.test((document.getElementById('status')||{}).textContent||"")`,
			nil, chromedp.WithPollingTimeout(60*time.Second)),
		chromedp.Poll(`/proxy connected/.test((document.getElementById('status')||{}).textContent||"")`,
			nil, chromedp.WithPollingTimeout(20*time.Second)),
	); err != nil {
		t.Fatalf("engine boot / relay connect: %v", err)
	}

	// FS read of a file that exists only on the remote's disk.
	got := evalRPC(t, ctx, `window.nvim.request('nvim_eval', ['join(readfile("/host/preexisting.txt"), "\\n")'])`)
	if !strings.Contains(got, "on the remote") {
		t.Fatalf("remote FS read = %q", got)
	}
	// FS write -> lands on the remote's disk (through the relay).
	evalRPC(t, ctx, `window.nvim.request('nvim_eval', ['writefile(["via the relay"], "/host/relay.txt")'])`)
	time.Sleep(400 * time.Millisecond)
	assertDisk(t, filepath.Join(remoteRoot, "relay.txt"), "via the relay\n")
	// proc spawn on the remote.
	if out := evalRPC(t, ctx, `window.nvim.request('nvim_eval', ['system("echo remote-proc-ok")'])`); !strings.Contains(out, "remote-proc-ok") {
		t.Fatalf("remote proc = %q", out)
	}
}

// buildRvimBinary builds the rvim binary (for --serve-stdio) from the rvim module
// root (the parent of this e2e module).
func buildRvimBinary(t *testing.T) string {
	t.Helper()
	_, thisFile, _, _ := runtime.Caller(0)
	rvimRoot := filepath.Join(filepath.Dir(thisFile), "..") // e2e -> rvim module root
	out := filepath.Join(t.TempDir(), "rvim")
	cmd := exec.Command("go", "build", "-o", out, "./cmd/rvim")
	cmd.Dir = rvimRoot
	if combined, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("could not build the rvim binary: %v\n%s", err, combined)
	}
	return out
}
