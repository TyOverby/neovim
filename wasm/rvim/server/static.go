package server

import (
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// AssetServer serves the static browser bundle from an fs.FS. The bundle is the
// FLAT output of wasm/web/build-site.sh (index.html, the library + page JS,
// proxy-client.js, and the nvim.js/.wasm/.data engine artifacts all at the
// root), so serving is a straight file lookup — `/` maps to index.html. The
// source is either os.DirFS(--assets-dir) (dev) or an embedded FS (release).
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

	f, err := a.fsys.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.NotFound(w, r) // no directory listing
		return
	}

	w.Header().Set("Cache-Control", "no-store")
	if ct := contentTypes[strings.ToLower(path.Ext(name))]; ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	if rs, ok := f.(io.ReadSeeker); ok {
		// ServeContent adds Range support (helps the browser stream large .data).
		http.ServeContent(w, r, name, st.ModTime(), rs)
		return
	}
	_, _ = io.Copy(w, f)
}
