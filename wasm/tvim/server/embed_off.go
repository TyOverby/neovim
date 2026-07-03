//go:build !embed_assets

// The default build: no embedded bundle. Static assets, if any, come from
// --assets-dir. Build with `-tags embed_assets` (after assembling server/site/)
// to bake the bundle into the binary instead — see embed_on.go.
package server

import "io/fs"

// EmbeddedAssets reports no embedded bundle in the default build.
func EmbeddedAssets() (fs.FS, bool) { return nil, false }
