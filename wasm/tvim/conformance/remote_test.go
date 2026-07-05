package conformance

import (
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// TestRemoteStdioRelay runs the full conformance suite against the THREE-TIER
// path: app-server (relay) -> SSH-stdio -> `tvim --serve-stdio` remote. A local
// subprocess stands in for `ssh host tvim --serve-stdio` (identical mechanics —
// see wasm/spikes/stage5-ssh-stdio). This proves the stdio transport, the relay,
// and that every IO seam works end-to-end over it, jailed on the remote.
func TestRemoteStdioRelay(t *testing.T) {
	bin := buildTvim(t)
	runAgainst(t, RemoteTarget{
		Binary:      bin,
		Implemented: []string{"base", "fs", "proc", "pty", "sock"},
	})
}

// buildTvim builds the tvim binary (which provides --serve-stdio) into a temp
// path. Skips if the build can't run.
func buildTvim(t *testing.T) string {
	t.Helper()
	_, thisFile, _, _ := runtime.Caller(0)
	moduleRoot := filepath.Join(filepath.Dir(thisFile), "..") // conformance -> tvim module root
	out := filepath.Join(t.TempDir(), "tvim")
	cmd := exec.Command("go", "build", "-o", out, "./cmd/tvim")
	cmd.Dir = moduleRoot
	if combined, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("could not build the tvim binary for the remote relay test: %v\n%s", err, combined)
	}
	return out
}
