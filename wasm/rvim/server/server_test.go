package server

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// startTestServer brings up a server with a synthetic flat bundle dir and
// returns its base URL + a cleanup. (A real bundle is build-site.sh output; the
// test only needs the serving logic, so a couple of files suffice.)
func startTestServer(t *testing.T, proxyConfig bool) (string, *Server) {
	t.Helper()
	dir := t.TempDir()
	must := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	must("index.html", "<!doctype html><title>rvim</title>")
	must("app.js", "// app")
	must("nvim.wasm", "\x00asm fake")
	must("mod.mjs", "export const x = 1;")
	must("pkg.data", "0123456789")
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}

	srv := New(Config{
		Root:        t.TempDir(),
		Port:        0,
		Assets:      NewAssetServer(os.DirFS(dir)),
		ProxyConfig: proxyConfig,
	}, NewRegistry())
	if err := srv.Listen(); err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve() }()
	t.Cleanup(func() { _ = srv.Close(context.Background()) })
	return "http://" + srv.Addr(), srv
}

func get(t *testing.T, url string) (*http.Response, string) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, string(body)
}

func TestStaticServing(t *testing.T) {
	base, _ := startTestServer(t, false)

	// "/" serves index.html with the right content type.
	resp, body := get(t, base+"/")
	if resp.StatusCode != 200 || !strings.Contains(body, "rvim") {
		t.Fatalf("/ = %d %q", resp.StatusCode, body)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("index content-type = %q", ct)
	}

	// .wasm gets application/wasm (required for streaming instantiation).
	resp, _ = get(t, base+"/nvim.wasm")
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "application/wasm" {
		t.Fatalf("nvim.wasm = %d %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}

	// A missing file 404s; a traversal attempt does not escape the bundle.
	if resp, _ := get(t, base+"/nope.js"); resp.StatusCode != 404 {
		t.Fatalf("missing file = %d, want 404", resp.StatusCode)
	}
	if resp, _ := get(t, base+"/../server.go"); resp.StatusCode == 200 {
		t.Fatalf("path traversal served a file outside the bundle")
	}
}

func TestStaticMIMEAndRange(t *testing.T) {
	base, _ := startTestServer(t, false)

	// .mjs must be text/javascript (else the browser refuses the ES module).
	resp, _ := get(t, base+"/mod.mjs")
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
		t.Fatalf(".mjs content-type = %q", ct)
	}
	// .data is application/octet-stream.
	resp, _ = get(t, base+"/pkg.data")
	if ct := resp.Header.Get("Content-Type"); ct != "application/octet-stream" {
		t.Fatalf(".data content-type = %q", ct)
	}

	// A Range request returns 206 + just the requested bytes (helps stream the
	// large .data package).
	req, _ := http.NewRequest("GET", base+"/pkg.data", nil)
	req.Header.Set("Range", "bytes=0-3")
	rresp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(rresp.Body)
	rresp.Body.Close()
	if rresp.StatusCode != http.StatusPartialContent || string(body) != "0123" {
		t.Fatalf("range request = %d %q, want 206 \"0123\"", rresp.StatusCode, body)
	}

	// A directory path is a 404 (no listing).
	if resp, _ := get(t, base+"/sub"); resp.StatusCode != 404 {
		t.Fatalf("GET /sub (dir) = %d, want 404", resp.StatusCode)
	}
}

func TestProxyConfigNoOpWhenDisabled(t *testing.T) {
	base, _ := startTestServer(t, false)
	resp, body := get(t, base+"/proxy-config.js")
	// Mirrors serve.js: a no-op 200 (NOT a 404), so the page runs as the
	// no-proxy demo with window.__NVIM_PROXY undefined.
	if resp.StatusCode != 200 {
		t.Fatalf("/proxy-config.js (disabled) = %d", resp.StatusCode)
	}
	if strings.Contains(body, "__NVIM_PROXY") {
		t.Fatalf("disabled proxy-config should not set __NVIM_PROXY: %q", body)
	}
}

func TestProxyConfigGeneratedWhenEnabled(t *testing.T) {
	base, _ := startTestServer(t, true)
	resp, body := get(t, base+"/proxy-config.js")
	if resp.StatusCode != 200 || !strings.Contains(body, "window.__NVIM_PROXY") {
		t.Fatalf("/proxy-config.js (enabled) = %d %q", resp.StatusCode, body)
	}
	// The ws URL is derived from the request Host so it works via localhost,
	// 127.0.0.1, or a forwarded port.
	if !strings.Contains(body, "ws://") || !strings.Contains(body, "/proxy") {
		t.Fatalf("generated config missing ws proxy url: %q", body)
	}
}
