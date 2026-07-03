//go:build embed_assets

// Built ONLY with `-tags embed_assets`. Embeds the static browser bundle
// assembled into server/site/ (the build-site.sh output) into the binary, so a
// release `tvim` is a single self-contained file with no --assets-dir needed.
// The default build (no tag) uses embed_off.go instead, so the repo compiles
// without a bundle present.
package server

import (
	"embed"
	"io/fs"
)

//go:embed all:site
var embeddedSite embed.FS

// EmbeddedAssets returns the embedded bundle subtree (rooted so "/" -> site/
// index.html). ok is false if the embed is empty/unavailable.
func EmbeddedAssets() (fs.FS, bool) {
	sub, err := fs.Sub(embeddedSite, "site")
	if err != nil {
		return nil, false
	}
	// Confirm there's actually an index.html (an empty site/ would compile but
	// serve nothing useful). precompress.sh may have gzipped it to index.html.gz
	// and dropped the raw, so accept either — the AssetServer serves both.
	if _, err := fs.Stat(sub, "index.html"); err != nil {
		if _, err := fs.Stat(sub, "index.html.gz"); err != nil {
			return nil, false
		}
	}
	return sub, true
}
