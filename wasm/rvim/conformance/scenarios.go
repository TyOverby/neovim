package conformance

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"time"
)

// expectedProxyUser mirrors server.serverUser: the username the io-proxy process
// runs as, reported in the hello ack (browser -> $USER). Kept in sync by hand so
// the conformance suite pins the wiring.
func expectedProxyUser() string {
	if u, err := user.Current(); err == nil && u.Username != "" {
		return u.Username
	}
	for _, k := range []string{"USER", "LOGNAME"} {
		if v := os.Getenv(k); v != "" {
			return v
		}
	}
	return ""
}

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
	oAPPEND = 0x400
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
				User string `json:"user"`
			}
			if err := r.Into(&out); err != nil {
				return err
			}
			if out.Config.Mount != "/host" {
				return fmt.Errorf("mount not echoed: %s", r.Result)
			}
			// The hello reports the io-proxy process's user (browser -> $USER).
			if want := expectedProxyUser(); out.User != want {
				return fmt.Errorf("hello user = %q, want %q", out.User, want)
			}
			// SECURITY: a client-supplied root must NOT widen the jail; the server
			// forces its own --root back.
			if out.Config.Root == "/tmp/attacker-controlled" {
				return fmt.Errorf("client-supplied root overrode the jail (got %q)", out.Config.Root)
			}
			return nil
		}},
		{"hello: version mismatch + malformed params still ack", "base", func(ctx context.Context, c *Client, root string) error {
			// A future/mismatched protocol version must still ack ok (the server
			// logs a warning but does not reject — refusing would break clients).
			r, err := c.HelloVersion(ctx, map[string]any{"mount": "/host"}, 999)
			if err != nil {
				return err
			}
			if !r.OK {
				return fmt.Errorf("version-mismatch hello rejected: %s", r.Error)
			}
			var out struct {
				ServerVersion int `json:"serverVersion"`
			}
			_ = r.Into(&out)
			if out.ServerVersion == 0 {
				return fmt.Errorf("ack missing serverVersion: %s", r.Result)
			}
			// Non-object (malformed) params must not break the handshake.
			r, err = c.HelloVersion(ctx, 42, 1)
			if err != nil {
				return err
			}
			if !r.OK {
				return fmt.Errorf("malformed-params hello rejected: %s", r.Error)
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
		{"fs: append open + write appends to EOF", "fs", func(ctx context.Context, c *Client, root string) error {
			// Create the file with "AB".
			r, err := req(ctx, c, "fs.open", map[string]any{"path": "/app.txt", "flags": oCREAT | oWRONLY | oTRUNC}, nil)
			if err != nil {
				return err
			}
			var op struct {
				Handle int `json:"handle"`
			}
			_ = r.Into(&op)
			if _, err := req(ctx, c, "fs.write", map[string]any{"handle": op.Handle, "pos": 0}, []byte("AB")); err != nil {
				return err
			}
			if _, err := req(ctx, c, "fs.close", map[string]any{"handle": op.Handle}, nil); err != nil {
				return err
			}
			// Re-open O_WRONLY|O_APPEND and write "CD"; it must append -> "ABCD".
			r, err = req(ctx, c, "fs.open", map[string]any{"path": "/app.txt", "flags": oWRONLY | oAPPEND}, nil)
			if err != nil {
				return err
			}
			_ = r.Into(&op)
			r, err = req(ctx, c, "fs.write", map[string]any{"handle": op.Handle, "pos": 0}, []byte("CD"))
			if err != nil {
				return err
			}
			var w struct {
				N int `json:"n"`
			}
			_ = r.Into(&w)
			if w.N != 2 {
				return fmt.Errorf("append write short: n=%d, want 2", w.N)
			}
			_, _ = req(ctx, c, "fs.close", map[string]any{"handle": op.Handle}, nil)
			onDisk, derr := os.ReadFile(filepath.Join(root, "app.txt"))
			if derr != nil {
				return derr
			}
			if string(onDisk) != "ABCD" {
				return fmt.Errorf("append result = %q, want \"ABCD\"", string(onDisk))
			}
			return nil
		}},
		{"fs: unknown + directory handle writes/reads are graceful no-ops", "fs", func(ctx context.Context, c *Client, root string) error {
			// Write/read on an unknown handle: ok with n:0 (the documented contract —
			// no panic, no escape). The engine should never send these, but a stale
			// handle after a reconnect must not crash or silently misbehave.
			r, err := req(ctx, c, "fs.write", map[string]any{"handle": 99999, "pos": 0}, []byte("x"))
			if err != nil {
				return err
			}
			var w struct {
				N int `json:"n"`
			}
			_ = r.Into(&w)
			if w.N != 0 {
				return fmt.Errorf("unknown-handle write n=%d, want 0", w.N)
			}
			r, err = req(ctx, c, "fs.read", map[string]any{"handle": 99999, "pos": 0, "len": 16}, nil)
			if err != nil {
				return err
			}
			var rd struct {
				N   int  `json:"n"`
				EOF bool `json:"eof"`
			}
			_ = r.Into(&rd)
			if rd.N != 0 || !rd.EOF || len(r.Payload) != 0 {
				return fmt.Errorf("unknown-handle read = {n:%d eof:%v %d bytes}", rd.N, rd.EOF, len(r.Payload))
			}
			// A DIRECTORY handle (no underlying file fd) writes as a no-op too.
			if _, err := req(ctx, c, "fs.mkdir", map[string]any{"path": "/dh", "mode": 0o755}, nil); err != nil {
				return err
			}
			r, _ = req(ctx, c, "fs.open", map[string]any{"path": "/dh", "flags": oRDONLY}, nil)
			var op struct {
				Handle int  `json:"handle"`
				IsDir  bool `json:"isDir"`
			}
			_ = r.Into(&op)
			if !op.IsDir {
				return fmt.Errorf("opening a dir did not report isDir")
			}
			r, err = req(ctx, c, "fs.write", map[string]any{"handle": op.Handle, "pos": 0}, []byte("x"))
			if err != nil {
				return err
			}
			_ = r.Into(&w)
			if w.N != 0 {
				return fmt.Errorf("dir-handle write n=%d, want 0", w.N)
			}
			return nil
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
		{"fs: by-path read/write (no handle) + jail", "fs", func(ctx context.Context, c *Client, root string) error {
			// Write a NEW file by path (no handle): exercises the stateless branch
			// (open O_RDWR, fall back to create) + its jail check.
			if _, err := req(ctx, c, "fs.write", map[string]any{"path": "/byp.txt", "pos": 0}, []byte("by-path")); err != nil {
				return err
			}
			if onDisk, _ := os.ReadFile(filepath.Join(root, "byp.txt")); string(onDisk) != "by-path" {
				return fmt.Errorf("by-path write = %q on disk", string(onDisk))
			}
			// Read it back by path (no handle).
			r, err := req(ctx, c, "fs.read", map[string]any{"path": "/byp.txt", "pos": 0, "len": 64}, nil)
			if err != nil {
				return err
			}
			if !bytes.Equal(r.Payload, []byte("by-path")) {
				return fmt.Errorf("by-path read = %q", r.Payload)
			}
			// The by-path branch must also be jailed.
			esc, err := c.Request(ctx, "fs.write", map[string]any{"path": "/../../escape-by-path", "pos": 0}, []byte("x"))
			if err != nil {
				return err
			}
			if esc.OK {
				return fmt.Errorf("SECURITY: by-path write escaped the jail")
			}
			return nil
		}},
		{"fs: partial read / EOF / past-end", "fs", func(ctx context.Context, c *Client, root string) error {
			r, err := req(ctx, c, "fs.open", map[string]any{"path": "/ten.txt", "flags": oCREAT | oWRONLY | oTRUNC}, nil)
			if err != nil {
				return err
			}
			var op struct {
				Handle int `json:"handle"`
			}
			_ = r.Into(&op)
			if _, err := req(ctx, c, "fs.write", map[string]any{"handle": op.Handle, "pos": 0}, []byte("0123456789")); err != nil {
				return err
			}
			_, _ = req(ctx, c, "fs.close", map[string]any{"handle": op.Handle}, nil)
			r, _ = req(ctx, c, "fs.open", map[string]any{"path": "/ten.txt", "flags": oRDONLY}, nil)
			_ = r.Into(&op)

			type rd struct {
				N   int  `json:"n"`
				EOF bool `json:"eof"`
			}
			check := func(pos, length int, wantN int, wantEOF bool, wantPayload string) error {
				r, err := req(ctx, c, "fs.read", map[string]any{"handle": op.Handle, "pos": pos, "len": length}, nil)
				if err != nil {
					return err
				}
				var got rd
				_ = r.Into(&got)
				if got.N != wantN || got.EOF != wantEOF || string(r.Payload) != wantPayload {
					return fmt.Errorf("read(pos=%d,len=%d) = {n:%d eof:%v %q}, want {n:%d eof:%v %q}",
						pos, length, got.N, got.EOF, r.Payload, wantN, wantEOF, wantPayload)
				}
				return nil
			}
			if err := check(0, 4, 4, false, "0123"); err != nil {
				return err
			}
			if err := check(8, 4, 2, true, "89"); err != nil {
				return err
			}
			if err := check(100, 4, 0, true, ""); err != nil {
				return err
			}
			_, _ = req(ctx, c, "fs.close", map[string]any{"handle": op.Handle}, nil)
			return nil
		}},
		{"fs: lstat/stat/readdir resolve symlinks + mode bits", "fs", func(ctx context.Context, c *Client, root string) error {
			// Build fixtures on disk directly (we own `root`).
			if err := os.Mkdir(filepath.Join(root, "d"), 0o755); err != nil {
				return err
			}
			if err := os.WriteFile(filepath.Join(root, "f.txt"), []byte("x"), 0o644); err != nil {
				return err
			}
			_ = os.Symlink(filepath.Join(root, "f.txt"), filepath.Join(root, "link-f"))
			_ = os.Symlink(filepath.Join(root, "d"), filepath.Join(root, "link-d"))

			// lstat a symlink. NOTE: the security jail realpaths every path
			// (resolveJailed) to defend against symlink escapes, so a leaf symlink
			// to an IN-JAIL target is resolved before lstat — lstat therefore reports
			// the TARGET (isLink:false), not the link. Known consequence of the
			// realpath-based jail (inherited from the Node prototype); pinned here.
			r, err := req(ctx, c, "fs.lstat", map[string]any{"path": "/link-f"}, nil)
			if err != nil {
				return err
			}
			var ls struct {
				Exists bool `json:"exists"`
				IsDir  bool `json:"isDir"`
			}
			_ = r.Into(&ls)
			if !ls.Exists || ls.IsDir {
				return fmt.Errorf("lstat link-f = %+v, want exists (resolved to the file target)", ls)
			}
			// stat follows the symlink: not a link.
			r, _ = req(ctx, c, "fs.stat", map[string]any{"path": "/link-f"}, nil)
			var st struct {
				Exists bool   `json:"exists"`
				IsLink bool   `json:"isLink"`
				IsDir  bool   `json:"isDir"`
				Mode   uint32 `json:"mode"`
			}
			_ = r.Into(&st)
			if !st.Exists || st.IsLink || st.IsDir {
				return fmt.Errorf("stat link-f = %+v, want followed (not a link)", st)
			}
			// mode carries the type bits: S_IFREG (0x8000) for the regular file.
			r, _ = req(ctx, c, "fs.stat", map[string]any{"path": "/f.txt"}, nil)
			_ = r.Into(&st)
			if st.Mode&0x8000 == 0 {
				return fmt.Errorf("f.txt mode 0%o missing S_IFREG", st.Mode)
			}
			// readdir resolves a symlink-to-dir to isDir:true.
			r, _ = req(ctx, c, "fs.readdir", map[string]any{"path": "/"}, nil)
			var dir struct {
				Entries []struct {
					Name  string `json:"name"`
					IsDir bool   `json:"isDir"`
				} `json:"entries"`
			}
			_ = r.Into(&dir)
			foundLinkD := false
			for _, e := range dir.Entries {
				if e.Name == "link-d" {
					foundLinkD = true
					if !e.IsDir {
						return fmt.Errorf("readdir link-d isDir=false, want true (symlink-to-dir)")
					}
				}
			}
			if !foundLinkD {
				return fmt.Errorf("readdir did not list link-d")
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

		{"proc: stderr stream + stdout_close/stderr_close pushes", "proc", func(ctx context.Context, c *Client, root string) error {
			id, err := spawnProc(ctx, c, []string{"sh", "-c", "echo out; echo err 1>&2"}, map[string]any{"wantOut": true, "wantErr": true})
			if err != nil {
				return err
			}
			out, err := c.WaitPush(ctx, pushForID("proc.stdout", id))
			if err != nil {
				return err
			}
			if !bytes.Contains(out.Payload, []byte("out")) {
				return fmt.Errorf("stdout = %q", out.Payload)
			}
			er, err := c.WaitPush(ctx, pushForID("proc.stderr", id))
			if err != nil {
				return err
			}
			if !bytes.Contains(er.Payload, []byte("err")) {
				return fmt.Errorf("stderr = %q", er.Payload)
			}
			if _, err := c.WaitPush(ctx, pushForID("proc.stdout_close", id)); err != nil {
				return fmt.Errorf("no proc.stdout_close: %w", err)
			}
			if _, err := c.WaitPush(ctx, pushForID("proc.stderr_close", id)); err != nil {
				return fmt.Errorf("no proc.stderr_close: %w", err)
			}
			return waitExit(ctx, c, "proc.exit", id, 0, -1)
		}},
		{"proc: empty argv + jail-escaping cwd are errors", "proc", func(ctx context.Context, c *Client, root string) error {
			r, err := c.Request(ctx, "proc.spawn", map[string]any{"argv": []string{}}, nil)
			if err != nil {
				return err
			}
			if r.OK {
				return fmt.Errorf("empty argv was accepted")
			}
			// A cwd under the mount that climbs out of the jail must be rejected.
			r, err = c.Request(ctx, "proc.spawn", map[string]any{"argv": []string{"true"}, "cwd": "/host/../../../../etc"}, nil)
			if err != nil {
				return err
			}
			if r.OK {
				return fmt.Errorf("SECURITY: jail-escaping cwd was accepted")
			}
			return nil
		}},
		{"proc: signal mapping (SIGINT + unknown fallback to SIGTERM)", "proc", func(ctx context.Context, c *Client, root string) error {
			id, err := spawnProc(ctx, c, []string{"sleep", "30"}, nil)
			if err != nil {
				return err
			}
			if _, err := req(ctx, c, "proc.kill", map[string]any{"id": id, "signal": 2}, nil); err != nil {
				return err
			}
			if err := waitExit(ctx, c, "proc.exit", id, -1, 2); err != nil {
				return err
			}
			// An unmapped signal number falls back to SIGTERM (15).
			id2, err := spawnProc(ctx, c, []string{"sleep", "30"}, nil)
			if err != nil {
				return err
			}
			if _, err := req(ctx, c, "proc.kill", map[string]any{"id": id2, "signal": 99}, nil); err != nil {
				return err
			}
			return waitExit(ctx, c, "proc.exit", id2, -1, 15)
		}},
		{"proc/pty: unknown id is a safe no-op (not a crash)", "proc", func(ctx context.Context, c *Client, root string) error {
			for _, m := range []string{"proc.kill", "proc.stdin", "proc.stdin_close", "pty.write", "pty.resize", "pty.kill"} {
				r, err := c.Request(ctx, m, map[string]any{"id": 99999}, []byte("x"))
				if err != nil {
					return err
				}
				if !r.OK {
					return fmt.Errorf("%s on unknown id returned error: %s", m, r.Error)
				}
			}
			return nil
		}},
		{"pty: rapid writes preserve order (no reordering)", "pty", func(ctx context.Context, c *Client, root string) error {
			r, err := req(ctx, c, "pty.spawn", map[string]any{"argv": []string{"cat"}, "cols": 80, "rows": 24}, nil)
			if err != nil {
				return err
			}
			var s struct {
				ID int `json:"id"`
			}
			_ = r.Into(&s)
			// Three distinct rapid writes; the pty echoes the typed bytes. If the
			// in-order dispatch regressed (per-request goroutines), these reorder.
			for _, tok := range []string{"111", "222", "333"} {
				if _, err := req(ctx, c, "pty.write", map[string]any{"id": s.ID}, []byte(tok)); err != nil {
					return err
				}
			}
			cctx, cancel := context.WithTimeout(ctx, 4*time.Second)
			defer cancel()
			var acc []byte
			for {
				p, err := c.WaitPush(cctx, pushForID("pty.data", s.ID))
				if err != nil {
					return fmt.Errorf("only saw digits %q before timeout", filterDigits(acc))
				}
				acc = append(acc, p.Payload...)
				if d := filterDigits(acc); len(d) >= 9 {
					if !nonDecreasing(d) {
						return fmt.Errorf("REORDERED pty input: echoed digits = %q", d)
					}
					_, _ = req(ctx, c, "pty.kill", map[string]any{"id": s.ID, "signal": 9}, nil)
					return nil
				}
			}
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

		{"sock: getaddrinfo named/numeric/IPv6/empty-host", "sock", func(ctx context.Context, c *Client, root string) error {
			type addr struct {
				Family int `json:"family"`
				Port   int `json:"port"`
			}
			get := func(host string, service any) ([]addr, error) {
				r, err := req(ctx, c, "sock.getaddrinfo", map[string]any{"host": host, "service": service}, nil)
				if err != nil {
					return nil, err
				}
				var out struct {
					Addrs []addr `json:"addrs"`
				}
				_ = r.Into(&out)
				return out.Addrs, nil
			}
			// named service on a literal IPv4 (the synchronous literal-IP branch).
			a, err := get("127.0.0.1", "https")
			if err != nil {
				return err
			}
			if len(a) == 0 || a[0].Family != 4 || a[0].Port != 443 {
				return fmt.Errorf("127.0.0.1/https = %+v, want family4 port443", a)
			}
			// IPv6 literal -> family 6.
			a, err = get("::1", "http")
			if err != nil {
				return err
			}
			if len(a) == 0 || a[0].Family != 6 || a[0].Port != 80 {
				return fmt.Errorf("::1/http = %+v, want family6 port80", a)
			}
			// service as a JSON NUMBER (not a string).
			a, err = get("127.0.0.1", 8080)
			if err != nil {
				return err
			}
			if len(a) == 0 || a[0].Port != 8080 {
				return fmt.Errorf("numeric service = %+v, want port8080", a)
			}
			// empty host defaults to loopback.
			a, err = get("", "http")
			if err != nil {
				return err
			}
			if len(a) == 0 || a[0].Port != 80 {
				return fmt.Errorf("empty host = %+v, want a loopback addr port80", a)
			}
			return nil
		}},
		{"sock: connect refused -> ECONNREFUSED; unix connect + echo", "sock", func(ctx context.Context, c *Client, root string) error {
			// A closed TCP port -> sock.connect_err with code ECONNREFUSED.
			ln, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				return err
			}
			port := ln.Addr().(*net.TCPAddr).Port
			ln.Close() // free the port so the connect is refused
			r, err := req(ctx, c, "sock.connect", map[string]any{"host": "127.0.0.1", "port": port}, nil)
			if err != nil {
				return err
			}
			var s struct {
				ID int `json:"id"`
			}
			_ = r.Into(&s)
			p, err := c.WaitPush(ctx, pushForID("sock.connect_err", s.ID))
			if err != nil {
				return err
			}
			var ce struct {
				Code string `json:"code"`
			}
			_ = p.Into(&ce)
			if ce.Code != "ECONNREFUSED" {
				return fmt.Errorf("connect_err code = %q, want ECONNREFUSED", ce.Code)
			}
			// Unix-domain socket: connect + write + echo round-trip.
			dir, err := os.MkdirTemp("", "rvim-unix-")
			if err != nil {
				return err
			}
			defer os.RemoveAll(dir)
			sockPath := filepath.Join(dir, "echo.sock")
			uln, err := net.Listen("unix", sockPath)
			if err != nil {
				return err
			}
			defer uln.Close()
			go echoServer(uln)
			r, err = req(ctx, c, "sock.connect", map[string]any{"path": sockPath}, nil)
			if err != nil {
				return err
			}
			var u struct {
				ID int `json:"id"`
			}
			_ = r.Into(&u)
			if _, err := c.WaitPush(ctx, pushForID("sock.connect_ok", u.ID)); err != nil {
				return fmt.Errorf("unix connect_ok: %w", err)
			}
			if _, err := req(ctx, c, "sock.write", map[string]any{"id": u.ID}, []byte("unix-ping")); err != nil {
				return err
			}
			d, err := c.WaitPush(ctx, pushForID("sock.data", u.ID))
			if err != nil {
				return err
			}
			if !bytes.Contains(d.Payload, []byte("unix-ping")) {
				return fmt.Errorf("unix echo = %q", d.Payload)
			}
			_, _ = req(ctx, c, "sock.close", map[string]any{"id": u.ID}, nil)
			return nil
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

// filterDigits keeps only ASCII digits from b (used to track pty echo order).
func filterDigits(b []byte) []byte {
	out := make([]byte, 0, len(b))
	for _, c := range b {
		if c >= '0' && c <= '9' {
			out = append(out, c)
		}
	}
	return out
}

// nonDecreasing reports whether the digit sequence never goes backwards (so
// "111222333" passes, any reordering like "112213..." fails).
func nonDecreasing(d []byte) bool {
	for i := 1; i < len(d); i++ {
		if d[i] < d[i-1] {
			return false
		}
	}
	return true
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
