package server

import (
	"strings"
	"testing"
)

// TestChildEnvInjectsNvim: childEnv exports $NVIM (the connection's RPC socket)
// into a spawned child's environment so plugins/commands can drive nvim.
func TestChildEnvInjectsNvim(t *testing.T) {
	env := childEnv(nil, "/tmp/tvim-nvim-xyz.sock")
	found := ""
	for _, kv := range env {
		if strings.HasPrefix(kv, "NVIM=") {
			found = kv
		}
	}
	if found != "NVIM=/tmp/tvim-nvim-xyz.sock" {
		t.Fatalf("childEnv did not inject NVIM, got %q", found)
	}
	// With no socket, NVIM is not added.
	for _, kv := range childEnv(nil, "") {
		if strings.HasPrefix(kv, "NVIM=") {
			t.Fatalf("childEnv injected NVIM with no socket: %q", kv)
		}
	}
}
