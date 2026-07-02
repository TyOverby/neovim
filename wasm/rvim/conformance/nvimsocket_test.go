package conformance

import (
	"context"
	"os"
	"testing"
)

// TestNvimSocketExportedToChildren: a child spawned by the server inherits $NVIM
// (the RPC socket path sent in the hello), so plugins/commands can connect back
// to nvim. Server-level (no browser): exercises hello -> ctx.Config.NvimSocket ->
// childEnv injection -> proc.spawn.
func TestNvimSocketExportedToChildren(t *testing.T) {
	root, err := os.MkdirTemp("", "rvim-nvimsock-")
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
	const sock = "/tmp/rvim-nvim-conformance.sock"
	if _, err := c.Hello(ctx, map[string]any{"nvimSocket": sock}); err != nil {
		t.Fatal(err)
	}

	r, err := c.Request(ctx, "proc.spawn",
		map[string]any{"argv": []string{"sh", "-c", "printf %s \"$NVIM\""}, "wantOut": true}, nil)
	if err != nil || !r.OK {
		t.Fatalf("spawn: %v %s", err, r.Error)
	}
	var s struct {
		ID int `json:"id"`
	}
	_ = r.Into(&s)
	out, err := c.WaitPush(ctx, pushForID("proc.stdout", s.ID))
	if err != nil {
		t.Fatal(err)
	}
	if string(out.Payload) != sock {
		t.Fatalf("child $NVIM = %q, want %q", out.Payload, sock)
	}
}
