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
	params, _ := json.Marshal(map[string]any{
		"argv": []string{"/bin/sh", "-c", script},
		"cwd":  t.TempDir(),
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
	sess := host.attach("s1", "", sink1)
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
	host.attach("s1", "", sink2)

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
	sess := host.attach("s1", "", sink1)
	spawnPTY(t, sess, `printf hi; exit 0`)
	id := spawnReqID(t, sink1)

	sess.detach(sink1)
	// Give the child time to print + exit while detached.
	waitFor(t, func() bool { return sess.exitPendingSet(id) })

	sink2 := &memSink{}
	host.attach("s1", "", sink2)
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
	sess := host.attach("s1", "", sink)
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

// TestSessionWriteRoundTrip: input written to a PTY reaches the child and drives
// output. (A PTY echoes input by default, so we assert the child's marker appears
// rather than fighting echo for an exact match.)
func TestSessionWriteRoundTrip(t *testing.T) {
	host := NewSessionHost()
	defer host.Close()

	sink := &memSink{}
	sess := host.attach("s1", "", sink)
	spawnPTY(t, sess, `while IFS= read -r _; do printf 'TOKEN\n'; done`)
	id := spawnReqID(t, sink)

	writeParams, _ := json.Marshal(map[string]any{"id": id})
	sess.dispatch(proxy.Header{T: proxy.TReq, ID: 2, Method: "pty.write", Params: writeParams}, []byte("go\n"))

	waitFor(t, func() bool { return strings.Contains(string(sink.data(id)), "TOKEN") })
}
