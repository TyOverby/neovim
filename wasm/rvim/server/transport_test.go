package server

import (
	"strings"
	"testing"
)

// TestRemoteArgvThreadsSession checks that the app-server relay appends the
// browser's durable-PTY session id to the remote command (and only then), without
// mutating the shared base slice.
func TestRemoteArgvThreadsSession(t *testing.T) {
	base := []string{"ssh", "-T", "host", "rvim", "--serve-stdio", "--root", "/p"}

	got := remoteArgv(base, "tab-abc")
	want := strings.Join(append(append([]string(nil), base...), "--session", "tab-abc"), " ")
	if strings.Join(got, " ") != want {
		t.Fatalf("with session:\n got %q\nwant %q", strings.Join(got, " "), want)
	}

	// No session -> no --session flag (base behaviour: non-durable PTYs).
	if got := remoteArgv(base, ""); strings.Join(got, " ") != strings.Join(base, " ") {
		t.Fatalf("empty session changed argv: %q", strings.Join(got, " "))
	}

	// The base slice must be untouched (it is shared across connections).
	if strings.Join(base, " ") != "ssh -T host rvim --serve-stdio --root /p" {
		t.Fatalf("base slice mutated: %q", strings.Join(base, " "))
	}
}
