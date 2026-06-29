package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
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

// TestStaticPrecompressed covers the precompression-aware lookup: a `.gz`
// sibling is preferred for gzip-capable clients (served verbatim with
// Content-Encoding: gzip), gunzipped on the fly for clients that can't take
// gzip, and a raw-only asset is unaffected. Mirrors what precompress.sh + the
// embedded release build produce.
func TestStaticPrecompressed(t *testing.T) {
	raw := []byte("(()=>{ /* a sizeable app bundle body */ })();")
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(raw); err != nil {
		t.Fatal(err)
	}
	zw.Close()
	gz := buf.Bytes()

	// big.js: precompressed only (raw dropped — the embedded-release shape).
	// app.js: raw only (the dev --assets-dir shape). both.js: raw + .gz.
	fsys := fstest.MapFS{
		"big.js.gz":  {Data: gz},
		"app.js":     {Data: raw},
		"both.js":    {Data: raw},
		"both.js.gz": {Data: gz},
	}
	a := NewAssetServer(fsys)
	do := func(path, ae string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		if ae != "" {
			req.Header.Set("Accept-Encoding", ae)
		}
		rec := httptest.NewRecorder()
		a.ServeHTTP(rec, req)
		return rec
	}

	// gzip client + precompressed sibling: serve the .gz bytes verbatim, with
	// the LOGICAL .js content type (not the gz's), Content-Encoding, and Vary.
	rec := do("/big.js", "gzip, deflate, br")
	if rec.Code != 200 || rec.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("big.js gzip = %d enc=%q", rec.Code, rec.Header().Get("Content-Encoding"))
	}
	if !bytes.Equal(rec.Body.Bytes(), gz) {
		t.Fatalf("big.js gzip body is not the verbatim .gz bytes")
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
		t.Fatalf("big.js content-type = %q, want text/javascript", ct)
	}
	if rec.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatalf("big.js missing Vary: Accept-Encoding")
	}

	// non-gzip client, only the .gz exists: decompress on the fly to identity.
	rec = do("/big.js", "")
	if rec.Code != 200 || rec.Header().Get("Content-Encoding") != "" {
		t.Fatalf("big.js identity = %d enc=%q", rec.Code, rec.Header().Get("Content-Encoding"))
	}
	if !bytes.Equal(rec.Body.Bytes(), raw) {
		t.Fatalf("big.js identity body = %q, want decompressed raw", rec.Body.Bytes())
	}

	// raw-only asset with a gzip client: no .gz sibling, so plain raw (no
	// Content-Encoding, no Vary — nothing to vary on).
	rec = do("/app.js", "gzip")
	if rec.Code != 200 || rec.Header().Get("Content-Encoding") != "" {
		t.Fatalf("app.js gzip = %d enc=%q, want raw", rec.Code, rec.Header().Get("Content-Encoding"))
	}
	if !bytes.Equal(rec.Body.Bytes(), raw) {
		t.Fatalf("app.js body mismatch")
	}

	// both present: gzip client gets the .gz; identity client gets raw. Both Vary.
	if rec := do("/both.js", "gzip"); rec.Header().Get("Content-Encoding") != "gzip" || rec.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatalf("both.js gzip enc=%q vary=%q", rec.Header().Get("Content-Encoding"), rec.Header().Get("Vary"))
	}
	if rec := do("/both.js", "identity"); rec.Header().Get("Content-Encoding") != "" || rec.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatalf("both.js identity enc=%q vary=%q", rec.Header().Get("Content-Encoding"), rec.Header().Get("Vary"))
	}

	// q=0 explicitly disables gzip even though the token is present.
	if rec := do("/big.js", "gzip;q=0"); rec.Header().Get("Content-Encoding") != "" {
		t.Fatalf("gzip;q=0 should not serve gzip, got enc=%q", rec.Header().Get("Content-Encoding"))
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
