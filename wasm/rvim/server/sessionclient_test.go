package server

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"rvim/proxy"
)

// startDaemon brings up a real session-host daemon on a temp socket.
func startDaemon(t *testing.T) string {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "host.sock")
	h := NewSessionHost()
	go func() { _ = h.Serve(sock) }()
	t.Cleanup(h.Close)
	waitFor(t, func() bool {
		_, err := os.Stat(sock)
		return err == nil
	})
	return sock
}

// stdioBrowser is the browser end of a --serve-stdio io-proxy: it speaks the
// length-prefixed proxy framing over an os.Pipe pair, while the io-proxy runs in a
// goroutine. Closing it drops the connection (the io-proxy's stdin hits EOF).
type stdioBrowser struct {
	in  *os.File // test writes -> io-proxy stdin
	out *os.File // io-proxy stdout -> test reads
	rw  *stdioFrameRW
}

func newStdioBrowser(t *testing.T, sock, session, root string) *stdioBrowser {
	t.Helper()
	srvIn, testW, err := os.Pipe() // io-proxy reads srvIn; test writes testW
	if err != nil {
		t.Fatal(err)
	}
	testR, srvOut, err := os.Pipe() // io-proxy writes srvOut; test reads testR
	if err != nil {
		t.Fatal(err)
	}
	srv := New(Config{Root: root, Session: session, DaemonSock: sock}, NewRegistry())
	go func() {
		_ = srv.ServeStdio(srvIn, srvOut)
		srvOut.Close()
		srvIn.Close()
	}()
	b := &stdioBrowser{in: testW, out: testR, rw: &stdioFrameRW{r: bufio.NewReader(testR), w: testW}}
	// Handshake: the io-proxy expects a hello; ack confirms it is ready.
	b.send(proxy.Header{T: proxy.THello, ID: 1}, nil)
	b.readUntil(t, func(h proxy.Header, _ []byte) bool { return h.T == proxy.TRes && h.ID == 1 })
	return b
}

func (b *stdioBrowser) send(h proxy.Header, payload []byte) {
	raw, _ := proxy.Encode(h, payload)
	_ = b.rw.writeRaw(raw)
}

// readUntil reads frames until pred matches or the link closes; returns the
// matching frame's payload (nil on close).
func (b *stdioBrowser) readUntil(t *testing.T, pred func(proxy.Header, []byte) bool) (proxy.Header, []byte) {
	t.Helper()
	for {
		raw, err := b.rw.readRaw()
		if err != nil {
			return proxy.Header{}, nil
		}
		h, payload, derr := proxy.Decode(raw)
		if derr != nil {
			continue
		}
		if pred(h, payload) {
			return h, payload
		}
	}
}

func (b *stdioBrowser) drop() { b.in.Close(); b.out.Close() }

// collectLines pumps pty.data for id, parsing "L<n>" lines, until the link closes;
// returns the ordered integers seen. Runs in a goroutine (used for conn1, which is
// dropped to end it).
func collectLines(b *stdioBrowser, id int, out chan<- []int) {
	var buf []byte
	var nums []int
	for {
		raw, err := b.rw.readRaw()
		if err != nil {
			out <- nums
			return
		}
		h, payload, derr := proxy.Decode(raw)
		if derr != nil || h.Method != "pty.data" || frameID(h) != id {
			continue
		}
		buf = append(buf, payload...)
		buf, nums = extractLines(buf, nums)
	}
}

// extractLines pulls complete "L<n>" lines out of buf, appending their integers to
// nums, and returns the unconsumed tail + the grown slice.
func extractLines(buf []byte, nums []int) ([]byte, []int) {
	for {
		i := indexByteSlice(buf, '\n')
		if i < 0 {
			return buf, nums
		}
		ln := strings.TrimRight(string(buf[:i]), "\r")
		buf = buf[i+1:]
		if strings.HasPrefix(ln, "L") {
			if n, err := strconv.Atoi(ln[1:]); err == nil {
				nums = append(nums, n)
			}
		}
	}
}

func indexByteSlice(b []byte, c byte) int {
	for i, x := range b {
		if x == c {
			return i
		}
	}
	return -1
}

// TestServeStdioDurablePTYReattach is the Phase-1b integration: a :terminal-style
// PTY survives a transport drop and the browser reattaches to the SAME shell, with
// output continuous across the gap (process kept running; output buffered during
// the outage is replayed). Exercises the full io-proxy -> daemon delegation.
func TestServeStdioDurablePTYReattach(t *testing.T) {
	sock := startDaemon(t)
	root := t.TempDir()

	b1 := newStdioBrowser(t, sock, "tab-1", root)
	// A slow infinite emitter so output spans the detach window.
	script := `i=0; while :; do i=$((i+1)); printf 'L%d\n' "$i"; sleep 0.02; done`
	params, _ := json.Marshal(map[string]any{
		"argv": []string{"/bin/sh", "-c", script},
		"cwd":  root, "env": map[string]string{"PATH": os.Getenv("PATH")},
		"cols": 80, "rows": 24,
	})
	b1.send(proxy.Header{T: proxy.TReq, ID: 2, Method: "pty.spawn", Params: params}, nil)
	res, _ := b1.readUntil(t, func(h proxy.Header, _ []byte) bool { return h.T == proxy.TRes && h.ID == 2 })
	var sr struct {
		ID int `json:"id"`
	}
	_ = json.Unmarshal(res.Result, &sr)
	id := sr.ID
	if id < ptyIDBase {
		t.Fatalf("spawn id %d below daemon base", id)
	}

	// Collect a few lines on conn1, then drop it.
	ch1 := make(chan []int, 1)
	go collectLines(b1, id, ch1)
	time.Sleep(150 * time.Millisecond)
	b1.drop()
	nums1 := <-ch1
	if len(nums1) == 0 {
		t.Fatalf("conn1 saw no output before drop")
	}
	last1 := nums1[len(nums1)-1]

	// Let the shell keep running (and emitting) while fully detached.
	time.Sleep(150 * time.Millisecond)

	// Reattach a fresh connection with the SAME session key — no re-spawn. Read
	// inline until the continuation runs well past conn1's last line, then kill.
	b2 := newStdioBrowser(t, sock, "tab-1", root)
	var nums2 []int
	var buf []byte
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		raw, err := b2.rw.readRaw()
		if err != nil {
			break
		}
		h, payload, derr := proxy.Decode(raw)
		if derr != nil || h.Method != "pty.data" || frameID(h) != id {
			continue
		}
		buf = append(buf, payload...)
		buf, nums2 = extractLines(buf, nums2)
		// Collect enough continuation lines for the contiguity/progress checks,
		// regardless of how large the seam gap is.
		if len(nums2) >= 6 {
			break
		}
	}
	b2.send(proxy.Header{T: proxy.TReq, ID: 3, Method: "pty.kill", Params: mustJSON(map[string]any{"id": id, "signal": 9})}, nil)
	b2.drop()

	if len(nums2) == 0 {
		t.Fatalf("conn2 saw no output after reattach")
	}
	// The shell kept running and the browser reattached to it (durability): conn2
	// sees the SAME pty's continued output, strictly after conn1's last line.
	//
	// Guarantees that hold WITHOUT end-to-end acks:
	//   - No duplication / no backward jump: conn2's first line is past conn1's last
	//     (the daemon never re-sends what it already handed the dropped client).
	//   - Internal contiguity: once reattached, output is gap-free and increasing.
	//   - Forward progress: the process is alive and producing.
	// A bounded gap AT THE SEAM is allowed: output the io-proxy pulled from the
	// daemon but couldn't push to the browser before the drop is lost (the daemon
	// counts it delivered). Phase 1c adds a browser byte-offset ack so the daemon
	// replays from the last byte the browser actually rendered — closing the seam
	// to exactly-once. (For a terminal the gap is self-healing: the next redraw
	// repaints the screen.)
	if nums2[0] <= last1 {
		t.Fatalf("duplication/backward jump across reattach: conn1 last=%d, conn2 first=%d", last1, nums2[0])
	}
	for i := 1; i < len(nums2); i++ {
		if nums2[i] != nums2[i-1]+1 {
			t.Fatalf("non-contiguous output after reattach: %d then %d", nums2[i-1], nums2[i])
		}
	}
	if len(nums2) < 6 {
		t.Fatalf("too little continuation after reattach (process may not have survived): %v", nums2)
	}
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

// TestServeStdioColdAdopt is the Phase-2 cold-restore integration: a terminal
// spawned on one connection is adopted by a restore-spawn (env RVIM_ADOPT) on a
// FRESH connection of the same session, reattaching to the SAME live shell (same
// daemon pty id) and repainting from the ring — end-to-end through the io-proxy's
// marker handling and the daemon's (cwd,argv) match.
func TestServeStdioColdAdopt(t *testing.T) {
	sock := startDaemon(t)
	root := t.TempDir()

	b1 := newStdioBrowser(t, sock, "tab-cold", root)
	argv := []string{"/bin/sh", "-c", `printf 'MARK-XYZ\r\n'; while IFS= read -r _; do :; done`}
	spawn := func(b *stdioBrowser, reqID int, env map[string]any) {
		p := map[string]any{"argv": argv, "cwd": "", "cols": 80, "rows": 24}
		if env != nil {
			p["env"] = env
		}
		b.send(proxy.Header{T: proxy.TReq, ID: reqID, Method: "pty.spawn", Params: mustJSON(p)}, nil)
	}
	spawn(b1, 2, nil)
	res, _ := b1.readUntil(t, func(h proxy.Header, _ []byte) bool { return h.T == proxy.TRes && h.ID == 2 })
	var sr struct {
		ID      int  `json:"id"`
		Adopted bool `json:"adopted"`
	}
	_ = json.Unmarshal(res.Result, &sr)
	if sr.Adopted {
		t.Fatalf("first spawn should not adopt")
	}
	id := sr.ID
	// Drain the marker so it's in the ring; then drop the connection.
	b1.readUntil(t, func(h proxy.Header, pl []byte) bool {
		return h.Method == "pty.data" && frameID(h) == id && strings.Contains(string(pl), "MARK-XYZ")
	})
	b1.drop()

	// Fresh connection, same session: a restore-spawn (RVIM_ADOPT) of the same
	// argv/cwd must adopt the SAME pty and repaint the marker from the ring.
	b2 := newStdioBrowser(t, sock, "tab-cold", root)
	spawn(b2, 3, map[string]any{"RVIM_ADOPT": "1"})
	res2, _ := b2.readUntil(t, func(h proxy.Header, _ []byte) bool { return h.T == proxy.TRes && h.ID == 3 })
	var sr2 struct {
		ID      int  `json:"id"`
		Adopted bool `json:"adopted"`
	}
	_ = json.Unmarshal(res2.Result, &sr2)
	if !sr2.Adopted {
		t.Fatalf("restore-spawn did not adopt: %s", res2.Result)
	}
	if sr2.ID != id {
		t.Fatalf("adopted id %d, want original %d", sr2.ID, id)
	}
	// The ring repaint delivers the original marker to the fresh connection.
	b2.readUntil(t, func(h proxy.Header, pl []byte) bool {
		return h.Method == "pty.data" && frameID(h) == id && strings.Contains(string(pl), "MARK-XYZ")
	})

	b2.send(proxy.Header{T: proxy.TReq, ID: 4, Method: "pty.kill", Params: mustJSON(map[string]any{"id": id, "signal": 9})}, nil)
	b2.drop()
}
