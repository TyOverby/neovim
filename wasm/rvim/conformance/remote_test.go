package conformance

import (
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// TestRemoteStdioRelay runs the full conformance suite against the THREE-TIER
// path: app-server (relay) -> SSH-stdio -> `rvim --serve-stdio` remote. A local
// subprocess stands in for `ssh host rvim --serve-stdio` (identical mechanics —
// see wasm/spikes/stage5-ssh-stdio). This proves the stdio transport, the relay,
// and that every IO seam works end-to-end over it, jailed on the remote.
func TestRemoteStdioRelay(t *testing.T) {
	bin := buildRvim(t)
	runAgainst(t, RemoteTarget{
		Binary:      bin,
		Implemented: []string{"base", "fs", "proc", "pty", "sock"},
	})
}

// buildRvim builds the rvim binary (which provides --serve-stdio) into a temp
// path. Skips if the build can't run.
func buildRvim(t *testing.T) string {
	t.Helper()
	_, thisFile, _, _ := runtime.Caller(0)
	moduleRoot := filepath.Join(filepath.Dir(thisFile), "..") // conformance -> rvim module root
	out := filepath.Join(t.TempDir(), "rvim")
	cmd := exec.Command("go", "build", "-o", out, "./cmd/rvim")
	cmd.Dir = moduleRoot
	if combined, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("could not build the rvim binary for the remote relay test: %v\n%s", err, combined)
	}
	return out
}
