package server

import (
	"encoding/json"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"rvim/proxy"
)

// memSink is an in-memory frameSink that records every frame the session sends,
// so a test can assert the exact byte stream a browser would see.
type memSink struct {
	mu     sync.Mutex
	frames []memFrame
}

type memFrame struct {
	h       proxy.Header
	payload []byte
}

func (m *memSink) send(h proxy.Header, payload []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.frames = append(m.frames, memFrame{h: h, payload: append([]byte(nil), payload...)})
	return nil
}

// data concatenates every pty.data payload for id, in send order.
func (m *memSink) data(id int) []byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []byte
	for _, f := range m.frames {
		if f.h.Method == "pty.data" && frameID(f.h) == id {
			out = append(out, f.payload...)
		}
	}
	return out
}

func (m *memSink) sawExit(id int) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, f := range m.frames {
		if f.h.Method == "pty.exit" && frameID(f.h) == id {
			return true
		}
	}
	return false
}

func frameID(h proxy.Header) int {
	var p struct {
		ID int `json:"id"`
	}
	_ = json.Unmarshal(h.Params, &p)
	return p.ID
}

// spawnID reads the {id} from the spawn response frame in the sink.
func spawnReqID(t *testing.T, m *memSink) int {
	t.Helper()
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, f := range m.frames {
		if f.h.T == proxy.TRes && len(f.h.Result) > 0 {
			var r struct {
				ID int `json:"id"`
			}
			if json.Unmarshal(f.h.Result, &r) == nil && r.ID >= ptyIDBase {
				return r.ID
			}
		}
	}
	t.Fatalf("no spawn id in sink frames")
	return 0
}

func spawnPTY(t *testing.T, s *ptySession, script string) {
	t.Helper()
	spawnPTYIn(t, s, t.TempDir(), []string{"/bin/sh", "-c", script})
}

func spawnPTYIn(t *testing.T, s *ptySession, cwd string, argv []string) {
	t.Helper()
	params, _ := json.Marshal(map[string]any{
		"argv": argv,
		"cwd":  cwd,
		"env":  map[string]string{"PATH": os.Getenv("PATH")},
		"cols": 80, "rows": 24,
	})
	s.dispatch(proxy.Header{T: proxy.TReq, ID: 1, Method: "pty.spawn", Params: params}, nil)
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("condition not met within timeout")
}

// TestSessionReattachReplaysExactlyOnce is the core durability invariant: across a
// detach/reattach mid-stream, the client sees every output byte exactly once, in
// order — the first sink gets a contiguous prefix, the second gets the exact
// remainder (buffered-then-live). No loss, no duplication.
func TestSessionReattachReplaysExactlyOnce(t *testing.T) {
	host := NewSessionHost()
	defer host.Close()

	sink1 := &memSink{}
	sess := host.attach("s1", sink1)
	// Emit 200 deterministic lines fast (pure-shell loop, no external bins needed
	// beyond /bin/sh + its printf builtin).
	spawnPTY(t, sess, `i=0; while [ $i -lt 200 ]; do i=$((i+1)); printf 'line%03d\n' "$i"; done`)
	id := spawnReqID(t, sink1)
	if id < ptyIDBase {
		t.Fatalf("pty id %d below base %d (would collide with proc ids)", id, ptyIDBase)
	}

	// Detach and reattach mid-stream to a fresh sink.
	sess.detach(sink1)
	sink2 := &memSink{}
	host.attach("s1", sink2)

	// Wait until the tail line appears across either sink (process ran to the end,
	// i.e. it survived the detach).
	want := []byte{}
	for i := 1; i <= 200; i++ {
		want = append(want, []byte(line(i))...)
	}
	waitFor(t, func() bool {
		return len(sink1.data(id))+len(sink2.data(id)) >= len(want)
	})

	got := append(append([]byte(nil), sink1.data(id)...), sink2.data(id)...)
	if string(got) != string(want) {
		t.Fatalf("reassembled output mismatch:\n got %d bytes\nwant %d bytes\ngot tail=%q",
			len(got), len(want), tail(got))
	}
	if len(sink1.data(id)) == 0 || len(sink2.data(id)) == 0 {
		t.Logf("note: prefix on sink1=%d bytes, remainder on sink2=%d bytes",
			len(sink1.data(id)), len(sink2.data(id)))
	}
}

// line is the expected output for iteration i. The PTY's ONLCR maps the script's
// '\n' to '\r\n' on the wire, so the expected stream carries '\r\n'.
func line(i int) string {
	d := []byte{byte('0' + (i/100)%10), byte('0' + (i/10)%10), byte('0' + i%10), '\r', '\n'}
	return "line" + string(d)
}

func tail(b []byte) []byte {
	if len(b) > 40 {
		return b[len(b)-40:]
	}
	return b
}

// TestSessionExitReplayedAfterReattach: a PTY that exits WHILE detached still
// delivers pty.exit to the next client that attaches (so the terminal closes).
func TestSessionExitReplayedAfterReattach(t *testing.T) {
	host := NewSessionHost()
	defer host.Close()

	sink1 := &memSink{}
	sess := host.attach("s1", sink1)
	spawnPTY(t, sess, `printf hi; exit 0`)
	id := spawnReqID(t, sink1)

	sess.detach(sink1)
	// Give the child time to print + exit while detached.
	waitFor(t, func() bool { return sess.exitPendingSet(id) })

	sink2 := &memSink{}
	host.attach("s1", sink2)
	waitFor(t, func() bool { return sink2.sawExit(id) })
	if string(sink2.data(id)) != "hi" {
		t.Fatalf("buffered output before exit not replayed: %q", sink2.data(id))
	}
}

// TestSessionGCKillsIdle: after detachTTL with no client, the GC reaps the session
// and kills its PTYs (a never-returning shell must not leak).
func TestSessionGCKillsIdle(t *testing.T) {
	host := NewSessionHost()
	host.detachTTL = time.Minute // exercised via injected clock, not real time
	defer host.Close()

	sink := &memSink{}
	sess := host.attach("s1", sink)
	spawnPTY(t, sess, `sleep 300`)
	id := spawnReqID(t, sink)
	pt := sess.get(id)
	if pt == nil {
		t.Fatalf("no pty after spawn")
	}

	sess.detach(sink)
	// Not yet idle long enough -> survives.
	host.gcOnce(time.Now())
	if pt.exited.Load() {
		t.Fatalf("pty killed before TTL elapsed")
	}
	// Past the TTL -> reaped and killed.
	sess.mu.Lock()
	dt := sess.detachedAt
	sess.mu.Unlock()
	host.gcOnce(dt.Add(2 * time.Minute))
	waitFor(t, func() bool { return pt.exited.Load() })

	host.mu.Lock()
	_, stillThere := host.sessions["s1"]
	host.mu.Unlock()
	if stillThere {
		t.Fatalf("idle session not removed by GC")
	}
}

// resResult returns the result object of the response frame with the given id.
func (m *memSink) resResult(id int) map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, f := range m.frames {
		if f.h.T == proxy.TRes && f.h.ID == id && len(f.h.Result) > 0 {
			var r map[string]any
			if json.Unmarshal(f.h.Result, &r) == nil {
				return r
			}
		}
	}
	return nil
}

// TestSessionAdoptOnSpawnRepaint exercises the cold-restore path: after a fresh
// client reattaches the session, a restore-spawn (adopt:true) matching a live PTY's
// (cwd, argv) reattaches to it — repainting from the full ring and reporting
// adopted:true — instead of spawning a new shell. A non-matching adopt spawns
// fresh (adopted:false). Warm auto-replay must NOT resend output to the fresh
// client.
func TestSessionAdoptOnSpawnRepaint(t *testing.T) {
	host := NewSessionHost()
	defer host.Close()

	cwd := t.TempDir()
	sink1 := &memSink{}
	sess := host.attach("s1", sink1)
	// Original terminal: marker then a long-lived read loop (stays alive).
	spawnPTYIn(t, sess, cwd, []string{"/bin/sh", "-c", `printf 'SCREEN-MARK\r\n'; sleep 30`})
	id := spawnReqID(t, sink1)
	waitFor(t, func() bool { return strings.Contains(string(sink1.data(id)), "SCREEN-MARK") })

	// Fresh client (reopened tab): warm auto-replay sends nothing it hasn't seen.
	sess.detach(sink1)
	sink2 := &memSink{}
	host.attach("s1", sink2)
	if strings.Contains(string(sink2.data(id)), "SCREEN-MARK") {
		t.Fatalf("warm auto-replay re-sent already-delivered output to a fresh client")
	}

	// Restore-spawn matching (cwd, argv): adopts the live PTY (same id) and repaints.
	adoptSpawn(sess, 7, cwd, []string{"/bin/sh", "-c", `printf 'SCREEN-MARK\r\n'; sleep 30`})
	r := sink2.resResult(7)
	if r == nil || r["adopted"] != true {
		t.Fatalf("restore-spawn should adopt the live pty: result=%v", r)
	}
	if int(r["id"].(float64)) != id {
		t.Fatalf("adopt returned id %v, want original %d", r["id"], id)
	}
	if !strings.Contains(string(sink2.data(id)), "SCREEN-MARK") {
		t.Fatalf("adopt did not repaint from the ring: %q", sink2.data(id))
	}

	// A restore-spawn with no matching live pty (different argv) spawns fresh.
	adoptSpawn(sess, 8, cwd, []string{"/bin/sh", "-c", `printf 'OTHER\r\n'; sleep 30`})
	r8 := sink2.resResult(8)
	if r8 == nil || r8["adopted"] != false {
		t.Fatalf("non-matching restore-spawn should spawn fresh: result=%v", r8)
	}

	dispatchReq(sess, 9, "pty.kill", map[string]any{"id": id, "signal": 9})
	dispatchReq(sess, 10, "pty.kill", map[string]any{"id": int(r8["id"].(float64)), "signal": 9})
}

// TestSessionCrossSessionAdopt: a PTY spawned in session A, after A detaches (its
// tab closed), is adopted by a restore-spawn in a DIFFERENT session B (a reopened
// tab with a fresh per-tab id) by (cwd,argv) match — re-homed into B, same id,
// repainted. This is what makes cold restore work now that each tab has its own
// session id.
func TestSessionCrossSessionAdopt(t *testing.T) {
	host := NewSessionHost()
	defer host.Close()
	cwd := t.TempDir()
	argv := []string{"/bin/sh", "-c", `printf 'XSESS\r\n'; sleep 30`}

	sinkA := &memSink{}
	sessA := host.attach("A", sinkA)
	spawnPTYIn(t, sessA, cwd, argv)
	idA := spawnReqID(t, sinkA)
	waitFor(t, func() bool { return strings.Contains(string(sinkA.data(idA)), "XSESS") })
	sessA.detach(sinkA) // tab A closed; pty orphaned but alive

	sinkB := &memSink{}
	sessB := host.attach("B", sinkB)
	adoptSpawn(sessB, 7, cwd, argv)
	r := sinkB.resResult(7)
	if r == nil || r["adopted"] != true {
		t.Fatalf("cross-session adopt failed: %v", r)
	}
	if int(r["id"].(float64)) != idA {
		t.Fatalf("adopted id %v, want A's orphaned %d", r["id"], idA)
	}
	waitFor(t, func() bool { return strings.Contains(string(sinkB.data(idA)), "XSESS") })

	dispatchReq(sessB, 9, "pty.kill", map[string]any{"id": idA, "signal": 9})
}

// TestSessionMultiTabIndependent: two concurrently-attached sessions (two tabs) are
// fully isolated — neither's terminal output leaks to the other (the regression the
// shared-session-id bug caused).
func TestSessionMultiTabIndependent(t *testing.T) {
	host := NewSessionHost()
	defer host.Close()

	sinkA := &memSink{}
	sessA := host.attach("A", sinkA)
	sinkB := &memSink{}
	sessB := host.attach("B", sinkB)

	spawnPTYIn(t, sessA, t.TempDir(), []string{"/bin/sh", "-c", `printf 'AAA\r\n'; sleep 30`})
	idA := spawnReqID(t, sinkA)
	spawnPTYIn(t, sessB, t.TempDir(), []string{"/bin/sh", "-c", `printf 'BBB\r\n'; sleep 30`})
	idB := spawnReqID(t, sinkB)

	waitFor(t, func() bool { return strings.Contains(string(sinkA.data(idA)), "AAA") })
	waitFor(t, func() bool { return strings.Contains(string(sinkB.data(idB)), "BBB") })
	if strings.Contains(string(sinkB.data(idA)), "AAA") {
		t.Fatalf("session A's terminal output leaked to session B")
	}
	if strings.Contains(string(sinkA.data(idB)), "BBB") {
		t.Fatalf("session B's terminal output leaked to session A")
	}

	dispatchReq(sessA, 8, "pty.kill", map[string]any{"id": idA, "signal": 9})
	dispatchReq(sessB, 9, "pty.kill", map[string]any{"id": idB, "signal": 9})
}

func dispatchReq(s *ptySession, reqID int, method string, params map[string]any) {
	s.dispatch(proxy.Header{T: proxy.TReq, ID: reqID, Method: method, Params: mustJSON(params)}, nil)
}

// adoptSpawn issues a session-restore pty.spawn (adopt:true) for cwd+argv.
func adoptSpawn(s *ptySession, reqID int, cwd string, argv []string) {
	dispatchReq(s, reqID, "pty.spawn", map[string]any{
		"argv": argv, "cwd": cwd, "env": map[string]string{"PATH": os.Getenv("PATH")},
		"cols": 80, "rows": 24, "adopt": true,
	})
}

// TestSessionWriteRoundTrip: input written to a PTY reaches the child and drives
// output. (A PTY echoes input by default, so we assert the child's marker appears
// rather than fighting echo for an exact match.)
func TestSessionWriteRoundTrip(t *testing.T) {
	host := NewSessionHost()
	defer host.Close()

	sink := &memSink{}
	sess := host.attach("s1", sink)
	spawnPTY(t, sess, `while IFS= read -r _; do printf 'TOKEN\n'; done`)
	id := spawnReqID(t, sink)

	writeParams, _ := json.Marshal(map[string]any{"id": id})
	sess.dispatch(proxy.Header{T: proxy.TReq, ID: 2, Method: "pty.write", Params: writeParams}, []byte("go\n"))

	waitFor(t, func() bool { return strings.Contains(string(sink.data(id)), "TOKEN") })
}
