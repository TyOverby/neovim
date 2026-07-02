package conformance

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestDisconnectKillsChildren is audit gap B11 (the highest-value missing test):
// when a connection drops, the per-connection cleanup must kill the child
// processes it spawned — the "closed tab leaves no orphans" guarantee and the
// reconnect contract's "live handles tear down". The server stays up; only the
// CLIENT connection closes.
func TestDisconnectKillsChildren(t *testing.T) {
	root, err := os.MkdirTemp("", "rvim-cleanup-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)

	url, stop, err := GoTarget{}.Start(root)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()

	ctx := context.Background()
	c, err := Dial(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Hello(ctx, map[string]any{}); err != nil {
		t.Fatal(err)
	}

	// `exec sleep` so the recorded $$ pid IS the long-running process (killing the
	// spawned child's pid then actually kills the sleeper, not just a shell that
	// leaves an orphaned sleep).
	if _, err := c.Request(ctx, "proc.spawn",
		map[string]any{"argv": []string{"sh", "-c", "echo $$ > pid.txt; exec sleep 60"}}, nil); err != nil {
		t.Fatal(err)
	}

	pid := waitForPid(t, filepath.Join(root, "pid.txt"))
	if err := syscall.Kill(pid, 0); err != nil {
		t.Fatalf("child pid %d not alive after spawn: %v", pid, err)
	}

	c.Close() // drop the connection — cleanup must reap the child

	if !waitGone(pid, 5*time.Second) {
		t.Fatalf("child pid %d still alive after disconnect (orphan leak)", pid)
	}
}

// TestDisconnectClosesListeners (B11, sockets): a sock.listen'd server must be
// closed when the connection drops, freeing the port.
func TestDisconnectClosesListeners(t *testing.T) {
	root := t.TempDir()
	url, stop, err := GoTarget{}.Start(root)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()

	ctx := context.Background()
	c, err := Dial(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Hello(ctx, map[string]any{}); err != nil {
		t.Fatal(err)
	}

	r, err := c.Request(ctx, "sock.listen", map[string]any{"host": "127.0.0.1", "port": 0}, nil)
	if err != nil || !r.OK {
		t.Fatalf("sock.listen failed: %v %s", err, r.Error)
	}
	var l struct {
		Port int `json:"port"`
	}
	_ = r.Into(&l)
	if l.Port == 0 {
		t.Fatal("listen reported no port")
	}

	c.Close() // drop the connection — the listener must close

	freed := false
	for i := 0; i < 250; i++ {
		if ln, e := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", l.Port)); e == nil {
			ln.Close()
			freed = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !freed {
		t.Fatalf("listener port %d not freed after disconnect", l.Port)
	}
}

func waitForPid(t *testing.T, pidFile string) int {
	t.Helper()
	for i := 0; i < 200; i++ {
		if b, err := os.ReadFile(pidFile); err == nil {
			if s := strings.TrimSpace(string(b)); s != "" {
				if pid, err := strconv.Atoi(s); err == nil {
					return pid
				}
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("child never wrote its pid")
	return 0
}

func waitGone(pid int, within time.Duration) bool {
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); err == syscall.ESRCH {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}
