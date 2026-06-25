// Package e2e is the headless-browser integration test for the rvim standalone
// app: it boots the REAL wasm Neovim engine in headless Chrome against the REAL
// in-process Go server (--proxy) and asserts real filesystem + process effects
// on disk. This is the durable verification that replaces the Node conformance
// oracle — once the Node prototype is removed, this is the safety net proving the
// full browser -> wasm engine -> Go server loop actually works.
//
// It is a SEPARATE Go module (e2e/go.mod, replace rvim => ../) so chromedp's
// dependency tree never touches the lean, vendored production module.
//
// Prerequisites (the test SKIPS, not fails, when missing):
//   - a Chrome/Chromium binary on PATH (Chrome >= 137 for JSPI);
//   - a built browser bundle. Either set RVIM_BUNDLE=<build-site.sh output>, or
//     have the wasm engine built (build-wasm/bin/nvim.*) so the test can run
//     wasm/web/build-site.sh itself.
//
// Run:  cd wasm/rvim/e2e && go test -v        (add -run TestBrowser… to focus)
package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	cdpruntime "github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"

	"rvim/server"
)

// TestBrowserProxyEndToEnd drives the real editor against the Go server and
// asserts FS read/write, process spawn, and readdir all hit the server's disk.
func TestBrowserProxyEndToEnd(t *testing.T) {
	bundle := bundleDir(t)
	if _, err := chromeFound(); err != nil {
		t.Skip("no Chrome/Chromium on PATH; skipping browser e2e")
	}

	// A hermetic jail root with one pre-existing file (to test FS read).
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "preexisting.txt"), "disk content 42\n")

	// The real Go server, in-process, with the proxy config generated so the page
	// connects back to it.
	srv := server.New(server.Config{
		Root:        root,
		Port:        0,
		Assets:      server.NewAssetServer(os.DirFS(bundle)),
		ProxyConfig: true,
	}, server.NewRegistry())
	if err := srv.Listen(); err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve() }()
	defer srv.Close(context.Background())
	url := "http://" + srv.Addr() + "/"
	t.Logf("rvim server at %s (root %s)", url, root)

	ctx, cancel := newChrome(t)
	defer cancel()
	ctx, cancelT := context.WithTimeout(ctx, 90*time.Second)
	defer cancelT()

	// Boot the engine and wait for the proxy to connect.
	if err := chromedp.Run(ctx,
		chromedp.Navigate(url),
		chromedp.Poll(`!!window.nvim && /attached/.test((document.getElementById('status')||{}).textContent||"")`,
			nil, chromedp.WithPollingTimeout(60*time.Second)),
		chromedp.Poll(`/proxy connected/.test((document.getElementById('status')||{}).textContent||"")`,
			nil, chromedp.WithPollingTimeout(20*time.Second)),
	); err != nil {
		t.Fatalf("engine boot / proxy connect: %v", err)
	}
	t.Log("engine attached + proxy connected")

	// 1) FS read: the editor reads a file that exists only on the server's disk.
	t.Run("fs read", func(t *testing.T) {
		got := evalRPC(t, ctx, `window.nvim.request('nvim_eval', ['join(readfile("/host/preexisting.txt"), "\\n")'])`)
		if !strings.Contains(got, "disk content 42") {
			t.Fatalf("editor read wrong content: %q", got)
		}
	})

	// 2) FS write via writefile(): fs.open(O_WRONLY|O_CREAT)+write+close.
	t.Run("fs write (writefile)", func(t *testing.T) {
		evalRPC(t, ctx, `window.nvim.request('nvim_eval', ['writefile(["written via","writefile"], "/host/wf.txt")'])`)
		time.Sleep(300 * time.Millisecond)
		assertDisk(t, filepath.Join(root, "wf.txt"), "written via\nwritefile\n")
	})

	// 3) FS write via the editor's real save flow (:w!). (Plain :w on a brand-new
	//    buffer trips nvim's 'readonly' diagnostic — a pre-existing engine-side
	//    papercut, not a proxy fault; the forced write proves the write path.)
	t.Run("fs write (editor :w!)", func(t *testing.T) {
		evalRPC(t, ctx, `window.nvim.request('nvim_cmd', [{cmd:'enew'}, {}])`)
		evalRPC(t, ctx, `window.nvim.request('nvim_buf_set_lines', [0, 0, -1, false, ['written via', 'the editor']])`)
		evalRPC(t, ctx, `window.nvim.request('nvim_buf_set_name', [0, '/host/from-editor.txt'])`)
		evalRPC(t, ctx, `window.nvim.request('nvim_cmd', [{cmd:'write', bang:true}, {}])`)
		time.Sleep(400 * time.Millisecond)
		assertDisk(t, filepath.Join(root, "from-editor.txt"), "written via\nthe editor\n")
	})

	// 3b) :w on a BRAND-NEW file (plain :w, no bang). Regression test for the
	//     errno papercut: the proxy returned Linux ENOENT(2) instead of the
	//     emscripten ENOENT(44) for a missing file, so nvim's "[New file]" check
	//     failed and the buffer was spuriously 'readonly' -> :w errored E45.
	t.Run("fs write (:w on a new file, no bang)", func(t *testing.T) {
		evalRPC(t, ctx, `window.nvim.request('nvim_cmd', [{cmd:'edit', args:['/host/new-file.txt']}, {}])`)
		ro := evalRPC(t, ctx, `window.nvim.request('nvim_eval', ['&readonly'])`)
		if ro != "0" {
			t.Fatalf("new file buffer is readonly (%s) — the E45 papercut", ro)
		}
		evalRPC(t, ctx, `window.nvim.request('nvim_buf_set_lines', [0, 0, -1, false, ['fresh write']])`)
		evalRPC(t, ctx, `window.nvim.request('nvim_cmd', [{cmd:'write'}, {}])`) // plain :w
		time.Sleep(400 * time.Millisecond)
		assertDisk(t, filepath.Join(root, "new-file.txt"), "fresh write\n")
	})

	// 4) proc: system() spawns a real process on the server.
	t.Run("proc spawn (system)", func(t *testing.T) {
		got := evalRPC(t, ctx, `window.nvim.request('nvim_eval', ['system("echo proc-proxy-ok")'])`)
		if !strings.Contains(got, "proc-proxy-ok") {
			t.Fatalf("system() returned %q", got)
		}
	})

	// 5) readdir: glob /host sees the server's files (including ones just written).
	t.Run("fs readdir (glob)", func(t *testing.T) {
		got := evalRPC(t, ctx, `window.nvim.request('nvim_eval', ['join(map(glob("/host/*", 0, 1), "fnamemodify(v:val, \\":t\\")"), ",")'])`)
		for _, want := range []string{"preexisting.txt", "wf.txt", "from-editor.txt"} {
			if !strings.Contains(got, want) {
				t.Fatalf("glob missing %q (got %q)", want, got)
			}
		}
	})

	// 6) PTY: :terminal runs a real shell ON THE SERVER; a command typed into it
	//    creates a file on the server's disk. NOTE: inside the terminal the shell
	//    sees REAL server paths, not the engine-side '/host' mount — its cwd is the
	//    jail root (resolveCwd maps the engine's /host cwd -> root) — so the command
	//    uses a RELATIVE path that lands in root.
	t.Run("pty terminal", func(t *testing.T) {
		termBuf := evalRPC(t, ctx, `window.nvim.request('nvim_eval', ['bufnr("%")'])`)
		evalRPC(t, ctx, `window.nvim.request('nvim_cmd', [{cmd:'terminal'}, {}])`)
		time.Sleep(2000 * time.Millisecond) // let the shell come up
		newBuf := evalRPC(t, ctx, `window.nvim.request('nvim_eval', ['bufnr("%")'])`)
		// `i` enters terminal-insert mode; the rest is typed into the PTY.
		evalRPC(t, ctx, `window.nvim.request('nvim_input', ['i'])`)
		time.Sleep(200 * time.Millisecond)
		evalRPC(t, ctx, `window.nvim.request('nvim_input', ['touch by-terminal.txt\n'])`)
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(filepath.Join(root, "by-terminal.txt")); err == nil {
				return
			}
			time.Sleep(250 * time.Millisecond)
		}
		dump := evalRPC(t, ctx, `window.nvim.request('nvim_eval', ['join(getline(1,"$"), "\\n")'])`)
		t.Fatalf("terminal did not create the file (termbuf %s -> %s); buffer:\n%s", termBuf, newBuf, dump)
	})
}

// ---- helpers ----------------------------------------------------------------

func chromeFound() (string, error) {
	for _, b := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser"} {
		if p, err := exec.LookPath(b); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("no chrome")
}

func newChrome(t *testing.T) (context.Context, context.CancelFunc) {
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.NoSandbox,
		chromedp.DisableGPU,
		chromedp.Flag("disable-dev-shm-usage", true),
	)
	allocCtx, cancelA := chromedp.NewExecAllocator(context.Background(), opts...)
	ctx, cancelC := chromedp.NewContext(allocCtx)
	return ctx, func() { cancelC(); cancelA() }
}

// evalRPC evaluates a window.nvim.request(...) promise, capturing both success
// and the nvim error array (so a failure shows the real E-message).
func evalRPC(t *testing.T, ctx context.Context, expr string) string {
	t.Helper()
	wrapped := `(` + expr + `).then(r=>JSON.stringify({ok:r})).catch(e=>JSON.stringify({err:e}))`
	var s string
	if err := chromedp.Run(ctx, chromedp.Evaluate(wrapped, &s, awaitPromise)); err != nil {
		t.Fatalf("eval %s: %v", expr, err)
	}
	var env struct {
		OK  json.RawMessage `json:"ok"`
		Err json.RawMessage `json:"err"`
	}
	_ = json.Unmarshal([]byte(s), &env)
	if len(env.Err) > 0 {
		t.Fatalf("nvim error for %s: %s", expr, string(env.Err))
	}
	var str string
	if json.Unmarshal(env.OK, &str) == nil {
		return str
	}
	return string(env.OK)
}

func awaitPromise(p *cdpruntime.EvaluateParams) *cdpruntime.EvaluateParams {
	return p.WithAwaitPromise(true)
}

func assertDisk(t *testing.T, path, want string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	if string(got) != want {
		t.Fatalf("%s on disk = %q, want %q", filepath.Base(path), string(got), want)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// bundleDir returns the browser bundle: RVIM_BUNDLE if set, else built via
// wasm/web/build-site.sh into a temp dir (skips if the wasm engine isn't built).
func bundleDir(t *testing.T) string {
	if b := os.Getenv("RVIM_BUNDLE"); b != "" {
		if _, err := os.Stat(filepath.Join(b, "index.html")); err != nil {
			t.Skipf("RVIM_BUNDLE=%s has no index.html: %v", b, err)
		}
		return b
	}
	_, thisFile, _, _ := runtime.Caller(0)
	repoRoot := filepath.Join(filepath.Dir(thisFile), "..", "..", "..") // e2e -> rvim -> wasm -> repo
	buildSite := filepath.Join(repoRoot, "wasm", "web", "build-site.sh")
	if _, err := os.Stat(filepath.Join(repoRoot, "build-wasm", "bin", "nvim.js")); err != nil {
		t.Skip("no wasm build (build-wasm/bin/nvim.js); set RVIM_BUNDLE or run wasm/build-nvim.sh first")
	}
	out := t.TempDir()
	cmd := exec.Command("bash", buildSite, out)
	cmd.Dir = repoRoot
	if combined, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("build-site.sh failed (set RVIM_BUNDLE to a prebuilt bundle): %v\n%s", err, combined)
	}
	return out
}
