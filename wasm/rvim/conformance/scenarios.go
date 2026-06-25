package conformance

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
)

// Scenario is one conformance check. Run executes against a client that has
// already completed the hello handshake, jailed to `root` (a fresh temp dir).
// Return an error to fail. The SAME set runs against every Target.
//
// Cap tags the capability the scenario exercises ("base"/"fs"/"proc"/"sock"/
// "pty"). A Target advertises which caps it implements, so a partially-built
// target runs exactly the scenarios it can satisfy.
type Scenario struct {
	Name string
	Cap  string
	Run  func(ctx context.Context, c *Client, root string) error
}

// FilterByCaps returns the scenarios whose Cap is in caps (nil caps = all).
func FilterByCaps(all []Scenario, caps []string) []Scenario {
	if caps == nil {
		return all
	}
	set := map[string]bool{}
	for _, c := range caps {
		set[c] = true
	}
	var out []Scenario
	for _, sc := range all {
		if set[sc.Cap] {
			out = append(out, sc)
		}
	}
	return out
}

// open(2) flag bits used by the scenarios (musl/Linux values).
const (
	oRDONLY = 0x0
	oWRONLY = 0x1
	oCREAT  = 0x40
	oTRUNC  = 0x200
)

// ---- small assertion helpers ------------------------------------------------

func mustOK(r Result, err error) (Result, error) {
	if err != nil {
		return r, err
	}
	if !r.OK {
		return r, fmt.Errorf("expected ok response, got error: %s", r.Error)
	}
	return r, nil
}

func req(ctx context.Context, c *Client, method string, params any, payload []byte) (Result, error) {
	return mustOK(c.Request(ctx, method, params, payload))
}

// Scenarios returns the full conformance set.
func Scenarios() []Scenario {
	return []Scenario{
		// ---- Phase 1 base methods ----
		{"ping", "base", func(ctx context.Context, c *Client, root string) error {
			r, err := req(ctx, c, "ping", map[string]any{}, nil)
			if err != nil {
				return err
			}
			var out struct {
				Pong bool  `json:"pong"`
				Now  int64 `json:"now"`
			}
			if err := r.Into(&out); err != nil {
				return err
			}
			if !out.Pong || out.Now == 0 {
				return fmt.Errorf("bad ping result: %s", r.Result)
			}
			return nil
		}},
		{"echo round-trips params + binary payload", "base", func(ctx context.Context, c *Client, root string) error {
			payload := []byte{0, 1, 2, 250, 255, 0, 7}
			r, err := req(ctx, c, "echo", map[string]any{"x": 42, "s": "hi"}, payload)
			if err != nil {
				return err
			}
			var out struct {
				X int    `json:"x"`
				S string `json:"s"`
			}
			if err := r.Into(&out); err != nil {
				return err
			}
			if out.X != 42 || out.S != "hi" {
				return fmt.Errorf("echo params not round-tripped: %s", r.Result)
			}
			if !bytes.Equal(r.Payload, payload) {
				return fmt.Errorf("echo payload not round-tripped: %v", r.Payload)
			}
			return nil
		}},
		{"hello acks with mount + server-forced root + version", "base", func(ctx context.Context, c *Client, root string) error {
			r, err := c.Hello(ctx, map[string]any{"mount": "/host", "root": "/tmp/attacker-controlled"})
			if err != nil {
				return err
			}
			if !r.OK {
				return fmt.Errorf("hello not ok: %s", r.Error)
			}
			var out struct {
				Hello  bool `json:"hello"`
				Config struct {
					Mount string `json:"mount"`
					Root  string `json:"root"`
				} `json:"config"`
			}
			if err := r.Into(&out); err != nil {
				return err
			}
			if out.Config.Mount != "/host" {
				return fmt.Errorf("mount not echoed: %s", r.Result)
			}
			// SECURITY: a client-supplied root must NOT widen the jail; the server
			// forces its own --root back.
			if out.Config.Root == "/tmp/attacker-controlled" {
				return fmt.Errorf("client-supplied root overrode the jail (got %q)", out.Config.Root)
			}
			return nil
		}},
		{"unknown method -> ok:false", "base", func(ctx context.Context, c *Client, root string) error {
			r, err := c.Request(ctx, "no.such.method", map[string]any{}, nil)
			if err != nil {
				return err
			}
			if r.OK || r.Error == "" {
				return fmt.Errorf("expected unknown-method error, got ok=%v err=%q", r.OK, r.Error)
			}
			return nil
		}},

		// ---- filesystem ----
		{"fs: open/write/close/stat/read round-trip", "fs", func(ctx context.Context, c *Client, root string) error {
			content := []byte("hello world\nsecond line\n")
			r, err := req(ctx, c, "fs.open", map[string]any{"path": "/a.txt", "flags": oCREAT | oWRONLY | oTRUNC, "mode": 0o644}, nil)
			if err != nil {
				return err
			}
			var op struct {
				Handle int  `json:"handle"`
				IsDir  bool `json:"isDir"`
			}
			if err := r.Into(&op); err != nil {
				return err
			}
			if op.IsDir {
				return fmt.Errorf("new file reported isDir")
			}
			r, err = req(ctx, c, "fs.write", map[string]any{"handle": op.Handle, "pos": 0}, content)
			if err != nil {
				return err
			}
			var w struct {
				N int `json:"n"`
			}
			_ = r.Into(&w)
			if w.N != len(content) {
				return fmt.Errorf("short write: %d of %d", w.N, len(content))
			}
			if _, err := req(ctx, c, "fs.close", map[string]any{"handle": op.Handle}, nil); err != nil {
				return err
			}
			// stat sees the new size.
			r, err = req(ctx, c, "fs.stat", map[string]any{"path": "/a.txt"}, nil)
			if err != nil {
				return err
			}
			var st struct {
				Exists bool `json:"exists"`
				IsDir  bool `json:"isDir"`
				Size   int  `json:"size"`
			}
			_ = r.Into(&st)
			if !st.Exists || st.IsDir || st.Size != len(content) {
				return fmt.Errorf("stat wrong: %s", r.Result)
			}
			// read it back.
			r, err = req(ctx, c, "fs.open", map[string]any{"path": "/a.txt", "flags": oRDONLY}, nil)
			if err != nil {
				return err
			}
			_ = r.Into(&op)
			r, err = req(ctx, c, "fs.read", map[string]any{"handle": op.Handle, "pos": 0, "len": 4096}, nil)
			if err != nil {
				return err
			}
			if !bytes.Equal(r.Payload, content) {
				return fmt.Errorf("read back mismatch: %q", r.Payload)
			}
			// And the bytes actually hit the real disk under root.
			onDisk, err := os.ReadFile(filepath.Join(root, "a.txt"))
			if err != nil || !bytes.Equal(onDisk, content) {
				return fmt.Errorf("file not on disk as expected: err=%v", err)
			}
			_, err = req(ctx, c, "fs.close", map[string]any{"handle": op.Handle}, nil)
			return err
		}},
		{"fs: stat missing -> exists:false (not error)", "fs", func(ctx context.Context, c *Client, root string) error {
			r, err := req(ctx, c, "fs.stat", map[string]any{"path": "/nope.txt"}, nil)
			if err != nil {
				return err
			}
			var st struct {
				Exists bool `json:"exists"`
			}
			_ = r.Into(&st)
			if st.Exists {
				return fmt.Errorf("missing path reported exists")
			}
			return nil
		}},
		{"fs: mkdir + readdir + rename + unlink", "fs", func(ctx context.Context, c *Client, root string) error {
			if _, err := req(ctx, c, "fs.mkdir", map[string]any{"path": "/sub", "mode": 0o755}, nil); err != nil {
				return err
			}
			if _, err := req(ctx, c, "fs.open", map[string]any{"path": "/sub/x.txt", "flags": oCREAT | oWRONLY | oTRUNC}, nil); err != nil {
				return err
			}
			r, err := req(ctx, c, "fs.readdir", map[string]any{"path": "/sub"}, nil)
			if err != nil {
				return err
			}
			var rd struct {
				Entries []struct {
					Name  string `json:"name"`
					IsDir bool   `json:"isDir"`
				} `json:"entries"`
			}
			_ = r.Into(&rd)
			found := false
			for _, e := range rd.Entries {
				if e.Name == "x.txt" {
					found = true
				}
			}
			if !found {
				return fmt.Errorf("readdir missing x.txt: %s", r.Result)
			}
			if _, err := req(ctx, c, "fs.rename", map[string]any{"from": "/sub/x.txt", "to": "/sub/y.txt"}, nil); err != nil {
				return err
			}
			if _, err := os.Stat(filepath.Join(root, "sub", "y.txt")); err != nil {
				return fmt.Errorf("rename did not land y.txt: %v", err)
			}
			if _, err := req(ctx, c, "fs.unlink", map[string]any{"path": "/sub/y.txt"}, nil); err != nil {
				return err
			}
			if _, err := os.Stat(filepath.Join(root, "sub", "y.txt")); !os.IsNotExist(err) {
				return fmt.Errorf("unlink did not remove y.txt")
			}
			return nil
		}},
		{"fs: jail rejects ../ escape", "fs", func(ctx context.Context, c *Client, root string) error {
			r, err := c.Request(ctx, "fs.open", map[string]any{"path": "/../../../../etc/passwd", "flags": oRDONLY}, nil)
			if err != nil {
				return err
			}
			if r.OK {
				return fmt.Errorf("jail escape was NOT rejected (security failure)")
			}
			return nil
		}},

		// ---- processes ----
		{"proc: spawn echo streams stdout + exit 0", "proc", func(ctx context.Context, c *Client, root string) error {
			id, err := spawnProc(ctx, c, []string{"echo", "conformance"}, map[string]any{"wantOut": true})
			if err != nil {
				return err
			}
			out, err := c.WaitPush(ctx, pushForID("proc.stdout", id))
			if err != nil {
				return err
			}
			if !bytes.Contains(out.Payload, []byte("conformance")) {
				return fmt.Errorf("stdout did not contain expected text: %q", out.Payload)
			}
			return waitExit(ctx, c, "proc.exit", id, 0, -1)
		}},
		{"proc: cat echoes stdin then exits on stdin_close", "proc", func(ctx context.Context, c *Client, root string) error {
			id, err := spawnProc(ctx, c, []string{"cat"}, map[string]any{"wantIn": true, "wantOut": true})
			if err != nil {
				return err
			}
			if _, err := req(ctx, c, "proc.stdin", map[string]any{"id": id}, []byte("round-trip\n")); err != nil {
				return err
			}
			if _, err := req(ctx, c, "proc.stdin_close", map[string]any{"id": id}, nil); err != nil {
				return err
			}
			out, err := c.WaitPush(ctx, pushForID("proc.stdout", id))
			if err != nil {
				return err
			}
			if !bytes.Contains(out.Payload, []byte("round-trip")) {
				return fmt.Errorf("cat did not echo stdin: %q", out.Payload)
			}
			return waitExit(ctx, c, "proc.exit", id, 0, -1)
		}},
		{"proc: missing binary -> exit 127", "proc", func(ctx context.Context, c *Client, root string) error {
			id, err := spawnProc(ctx, c, []string{"definitely-not-a-real-binary-zzz"}, map[string]any{"wantOut": true})
			if err != nil {
				return err
			}
			return waitExit(ctx, c, "proc.exit", id, 127, -1)
		}},
		{"proc: kill delivers the signal", "proc", func(ctx context.Context, c *Client, root string) error {
			id, err := spawnProc(ctx, c, []string{"sleep", "30"}, map[string]any{})
			if err != nil {
				return err
			}
			if _, err := req(ctx, c, "proc.kill", map[string]any{"id": id, "signal": 15}, nil); err != nil {
				return err
			}
			return waitExit(ctx, c, "proc.exit", id, -1, 15)
		}},

		// ---- sockets ----
		{"sock: getaddrinfo resolves localhost", "sock", func(ctx context.Context, c *Client, root string) error {
			r, err := req(ctx, c, "sock.getaddrinfo", map[string]any{"host": "localhost", "service": "80"}, nil)
			if err != nil {
				return err
			}
			var out struct {
				Addrs []struct {
					Family  int    `json:"family"`
					Address string `json:"address"`
					Port    int    `json:"port"`
				} `json:"addrs"`
			}
			_ = r.Into(&out)
			if len(out.Addrs) == 0 || out.Addrs[0].Port != 80 {
				return fmt.Errorf("getaddrinfo wrong: %s", r.Result)
			}
			return nil
		}},
		{"sock: outbound connect/write/data/close against a TCP echo", "sock", func(ctx context.Context, c *Client, root string) error {
			ln, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				return err
			}
			defer ln.Close()
			go echoServer(ln)
			port := ln.Addr().(*net.TCPAddr).Port

			r, err := req(ctx, c, "sock.connect", map[string]any{"host": "127.0.0.1", "port": port}, nil)
			if err != nil {
				return err
			}
			var s struct {
				ID int `json:"id"`
			}
			_ = r.Into(&s)
			if _, err := c.WaitPush(ctx, pushForID("sock.connect_ok", s.ID)); err != nil {
				return err
			}
			if _, err := req(ctx, c, "sock.write", map[string]any{"id": s.ID}, []byte("ping")); err != nil {
				return err
			}
			data, err := c.WaitPush(ctx, pushForID("sock.data", s.ID))
			if err != nil {
				return err
			}
			if !bytes.Contains(data.Payload, []byte("ping")) {
				return fmt.Errorf("echo mismatch: %q", data.Payload)
			}
			_, err = req(ctx, c, "sock.close", map[string]any{"id": s.ID}, nil)
			return err
		}},
		{"sock: inbound listen/incoming/accept/data", "sock", func(ctx context.Context, c *Client, root string) error {
			r, err := req(ctx, c, "sock.listen", map[string]any{"host": "127.0.0.1", "port": 0}, nil)
			if err != nil {
				return err
			}
			var l struct {
				ListenerID int `json:"listenerId"`
				Port       int `json:"port"`
			}
			_ = r.Into(&l)
			if l.Port == 0 {
				return fmt.Errorf("listen did not report a real port")
			}
			// Dial the bound port from this process.
			conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", l.Port))
			if err != nil {
				return err
			}
			defer conn.Close()
			inc, err := c.WaitPush(ctx, PushMethod("sock.incoming"))
			if err != nil {
				return err
			}
			var ip struct {
				ListenerID int `json:"listenerId"`
				ConnID     int `json:"connId"`
			}
			_ = inc.Into(&ip)
			if ip.ListenerID != l.ListenerID {
				return fmt.Errorf("incoming on wrong listener: %s", inc.Params)
			}
			if _, err := req(ctx, c, "sock.accept", map[string]any{"connId": ip.ConnID}, nil); err != nil {
				return err
			}
			// Client -> server bytes surface as sock.data on the accepted connId.
			if _, err := conn.Write([]byte("inbound-hi")); err != nil {
				return err
			}
			data, err := c.WaitPush(ctx, pushForID("sock.data", ip.ConnID))
			if err != nil {
				return err
			}
			if !bytes.Contains(data.Payload, []byte("inbound-hi")) {
				return fmt.Errorf("accepted socket data mismatch: %q", data.Payload)
			}
			// server -> client write reaches the dialer.
			if _, err := req(ctx, c, "sock.write", map[string]any{"id": ip.ConnID}, []byte("outbound-yo")); err != nil {
				return err
			}
			buf := make([]byte, 64)
			n, err := conn.Read(buf)
			if err != nil || !bytes.Contains(buf[:n], []byte("outbound-yo")) {
				return fmt.Errorf("dialer did not receive server write: n=%d err=%v", n, err)
			}
			_, err = req(ctx, c, "sock.listen_close", map[string]any{"listenerId": l.ListenerID}, nil)
			return err
		}},

		// ---- pty ----
		{"pty: spawn cat, write, see data, kill, exit", "pty", func(ctx context.Context, c *Client, root string) error {
			r, err := req(ctx, c, "pty.spawn", map[string]any{"argv": []string{"cat"}, "cols": 80, "rows": 24}, nil)
			if err != nil {
				return err
			}
			var s struct {
				ID int `json:"id"`
			}
			_ = r.Into(&s)
			if _, err := req(ctx, c, "pty.write", map[string]any{"id": s.ID}, []byte("hello-pty\n")); err != nil {
				return err
			}
			data, err := c.WaitPush(ctx, pushForID("pty.data", s.ID))
			if err != nil {
				return err
			}
			if !bytes.Contains(data.Payload, []byte("hello-pty")) {
				return fmt.Errorf("pty did not echo input: %q", data.Payload)
			}
			if _, err := req(ctx, c, "pty.kill", map[string]any{"id": s.ID, "signal": 9}, nil); err != nil {
				return err
			}
			_, err = c.WaitPush(ctx, pushForID("pty.exit", s.ID))
			return err
		}},
	}
}

// ---- scenario helpers -------------------------------------------------------

func spawnProc(ctx context.Context, c *Client, argv []string, extra map[string]any) (int, error) {
	params := map[string]any{"argv": argv}
	for k, v := range extra {
		params[k] = v
	}
	r, err := req(ctx, c, "proc.spawn", params, nil)
	if err != nil {
		return 0, err
	}
	var s struct {
		ID int `json:"id"`
	}
	if err := r.Into(&s); err != nil {
		return 0, err
	}
	return s.ID, nil
}

// pushForID matches a push of the given method whose params carry {"id":id}.
func pushForID(method string, id int) func(Push) bool {
	return func(p Push) bool {
		if p.Method != method {
			return false
		}
		var pp struct {
			ID int `json:"id"`
		}
		_ = p.Into(&pp)
		return pp.ID == id
	}
}

// waitExit waits for an exit push for id. wantCode/wantSignal of -1 means "don't
// care" for that field.
func waitExit(ctx context.Context, c *Client, method string, id, wantCode, wantSignal int) error {
	p, err := c.WaitPush(ctx, pushForID(method, id))
	if err != nil {
		return err
	}
	var ev struct {
		Code   int `json:"code"`
		Signal int `json:"signal"`
	}
	if err := p.Into(&ev); err != nil {
		return err
	}
	if wantCode >= 0 && ev.Code != wantCode {
		return fmt.Errorf("%s code = %d, want %d", method, ev.Code, wantCode)
	}
	if wantSignal >= 0 && ev.Signal != wantSignal {
		return fmt.Errorf("%s signal = %d, want %d", method, ev.Signal, wantSignal)
	}
	return nil
}

// echoServer accepts one connection and echoes bytes back until it closes.
func echoServer(ln net.Listener) {
	conn, err := ln.Accept()
	if err != nil {
		return
	}
	defer conn.Close()
	buf := make([]byte, 4096)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			_, _ = conn.Write(buf[:n])
		}
		if err != nil {
			return
		}
	}
}
