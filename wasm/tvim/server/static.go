package server

import (
	"compress/gzip"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strconv"
	"strings"
)

// AssetServer serves the static browser bundle from an fs.FS. The bundle is the
// FLAT output of wasm/web/build-site.sh (index.html, the library + page JS,
// proxy-client.js, and the nvim.js/.wasm/.data engine artifacts all at the
// root), so serving is a straight file lookup — `/` maps to index.html. The
// source is either os.DirFS(--assets-dir) (dev) or an embedded FS (release).
//
// Precompression: the bundle is dominated by a few large, highly compressible
// assets (nvim.wasm ~4.7MB→1.8MB, nvim-full.data ~22MB→5.6MB). For the embedded
// (release) build, wasm/tvim/precompress.sh gzips those in place to `<name>.gz`
// and drops the raw original, so the binary ships the compressed bytes and the
// server hands them straight to the browser with `Content-Encoding: gzip` — no
// per-request compression CPU and a far smaller download. The lookup is generic:
// for any request it prefers a `<name>.gz` sibling when the client accepts gzip,
// otherwise serves the raw file. The dev --assets-dir path (raw build-site.sh
// output, no .gz) is unaffected and keeps Range support.
type AssetServer struct {
	fsys fs.FS
}

// NewAssetServer wraps an fs.FS (e.g. os.DirFS(dir) or an embed.FS subtree).
func NewAssetServer(fsys fs.FS) *AssetServer { return &AssetServer{fsys: fsys} }

// contentTypes mirrors wasm/web/serve.js TYPES so the engine assets get the
// right MIME (notably application/wasm, required for streaming instantiation).
var contentTypes = map[string]string{
	".html": "text/html; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".mjs":  "text/javascript; charset=utf-8",
	".wasm": "application/wasm",
	".data": "application/octet-stream",
	".json": "application/json",
	".css":  "text/css; charset=utf-8",
	".map":  "application/json",
}

func (a *AssetServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	if p == "/" || p == "" {
		p = "/index.html"
	}
	// fs.FS uses slash-rooted, non-leading-slash, cleaned names; reject escapes.
	name := strings.TrimPrefix(path.Clean(p), "/")
	if name == "" || name == "." || strings.HasPrefix(name, "../") {
		http.NotFound(w, r)
		return
	}

	// Content-Type is keyed off the LOGICAL name's extension, regardless of
	// whether we end up serving the raw file or a `.gz` precompressed sibling.
	ct := contentTypes[strings.ToLower(path.Ext(name))]

	rawFile, rawInfo, hasRaw := a.openFile(name)
	gzFile, gzInfo, hasGz := a.openFile(name + ".gz")
	// Close whatever we don't serve; the served file is closed via defer below.
	defer func() {
		if rawFile != nil {
			rawFile.Close()
		}
		if gzFile != nil {
			gzFile.Close()
		}
	}()

	// 1. Client accepts gzip and we have a precompressed sibling: hand the
	// compressed bytes straight to the browser (it decompresses transparently —
	// fetch(), importScripts(), and WebAssembly.instantiateStreaming all do).
	if hasGz && acceptsGzip(r) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Vary", "Accept-Encoding")
		if ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Content-Length", strconv.FormatInt(gzInfo.Size(), 10))
		if r.Method == http.MethodHead {
			return
		}
		_, _ = io.Copy(w, gzFile)
		return
	}

	// 2. Raw file present: serve it as before, with Range support (lets the
	// browser stream the large .data; ServeContent also handles HEAD).
	if hasRaw {
		w.Header().Set("Cache-Control", "no-store")
		if hasGz {
			w.Header().Set("Vary", "Accept-Encoding")
		}
		if ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		if rs, ok := rawFile.(io.ReadSeeker); ok {
			http.ServeContent(w, r, name, rawInfo.ModTime(), rs)
			return
		}
		_, _ = io.Copy(w, rawFile)
		return
	}

	// 3. Only a precompressed `.gz` exists but the client can't take gzip (e.g.
	// curl with no Accept-Encoding). Decompress on the fly. Rare; no Range.
	if hasGz {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Vary", "Accept-Encoding")
		if ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		if r.Method == http.MethodHead {
			return
		}
		gr, err := gzip.NewReader(gzFile)
		if err != nil {
			http.Error(w, "corrupt asset", http.StatusInternalServerError)
			return
		}
		defer gr.Close()
		_, _ = io.Copy(w, gr)
		return
	}

	http.NotFound(w, r)
}

// openFile opens name and returns it with its info, or ok=false if it is
// missing or a directory (no directory listing). The caller owns Close.
func (a *AssetServer) openFile(name string) (fs.File, fs.FileInfo, bool) {
	f, err := a.fsys.Open(name)
	if err != nil {
		return nil, nil, false
	}
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		f.Close()
		return nil, nil, false
	}
	return f, st, true
}

// acceptsGzip reports whether the request's Accept-Encoding allows gzip (token
// present and not explicitly disabled with q=0).
func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		fields := strings.Split(strings.TrimSpace(part), ";")
		if strings.EqualFold(strings.TrimSpace(fields[0]), "gzip") {
			for _, p := range fields[1:] {
				if strings.EqualFold(strings.TrimSpace(p), "q=0") {
					return false
				}
			}
			return true
		}
	}
	return false
}
