package server

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/creack/pty"

	"rvim/proxy"
)

// SESSION HOST (stage 5 — durable PTYs). The `rvim --session-host` daemon makes
// :terminal survive a transport drop. In the base design a PTY is a per-connection
// child: when the browser's WebSocket (or the SSH pipe under --remote) drops, the
// io-proxy's cleanup SIGKILLs every shell, so a blip kills your terminals. That is
// correct for idempotent IO (reads/writes retry; one-shot spawns re-run) but wrong
// for a :terminal, which is long-lived stateful session: a running shell, an ssh
// inside it, scrollback, cwd, history.
//
// The daemon hosts that state OUTSIDE any single connection. It is a persistent
// per-user process on the IO host (the remote, under --remote) listening on a unix
// socket. Each browser tab is a SESSION keyed by a stable id the browser mints;
// per-connection io-proxy processes ATTACH to the session by key. The daemon owns
// the PTY children; when an attach client disconnects it KEEPS the shells running
// and buffers their output, and on reattach it replays the buffered output so the
// browser's terminal catches up. PTYs are reaped only on an idle TTL or explicit
// kill — never on a mere disconnect.
//
// Why this and not parking the ssh subprocess in the app-server: the daemon lives
// on the IO host, so sessions also survive an app-server restart / hard SSH death
// while the browser tab is alive. The cold case (browser itself gone — laptop
// reboot, closed tab) is out of scope here: nvim's terminal *screen* is browser-
// side volatile state no daemon can preserve; run shells under tmux for that.

const (
	// defaultRingCap bounds the per-PTY replay buffer (output produced while
	// detached). A runaway `yes` during a long outage must not OOM the daemon, so
	// we keep only the tail; the terminal redraws fully on the next refresh/resize.
	defaultRingCap = 256 * 1024
	// defaultDetachTTL is how long a session's PTYs stay alive after the last
	// attach client disconnects, before the daemon reaps them.
	defaultDetachTTL = 10 * time.Minute
	// ptyIDBase keeps daemon-allocated PTY ids out of the per-connection proc id
	// space. The browser routes pty.* and proc.* pushes through one shared
	// byServerId map, and proc ids are allocated locally by each (fresh-per-
	// reconnect) io-proxy starting at 1; a high, monotonic base guarantees a PTY
	// id never collides with a proc id for the life of the tab.
	ptyIDBase = 1 << 24
)

// frameSink delivers a frame to the currently-attached client. It abstracts the
// transport so the session core is unit-testable with an in-memory collector.
type frameSink interface {
	send(h proxy.Header, payload []byte) error
}

// ---- the daemon -------------------------------------------------------------

// SessionHost is the `rvim --session-host` daemon: a table of durable PTY
// sessions keyed by the browser-supplied session id.
type SessionHost struct {
	mu        sync.Mutex
	sessions  map[string]*ptySession
	nextPtyID int64 // global monotonic, base ptyIDBase

	ringCap   int
	detachTTL time.Duration

	stopGC chan struct{}
}

// NewSessionHost builds a daemon with default buffer/TTL policy.
func NewSessionHost() *SessionHost {
	return &SessionHost{
		sessions:  map[string]*ptySession{},
		nextPtyID: ptyIDBase,
		ringCap:   defaultRingCap,
		detachTTL: defaultDetachTTL,
		stopGC:    make(chan struct{}),
	}
}

func (h *SessionHost) allocPtyID() int { return int(atomic.AddInt64(&h.nextPtyID, 1)) }

// attach binds sink as session key's live client, creating the session on first
// use. It flushes any output buffered while the session was detached (so the
// browser's terminal catches up), then routes new output live to sink. Returns
// the session so the caller's read loop can dispatch its requests.
func (h *SessionHost) attach(key string, sink frameSink) *ptySession {
	h.mu.Lock()
	s := h.sessions[key]
	if s == nil {
		s = &ptySession{key: key, host: h, ptys: map[int]*daemonPty{}}
		h.sessions[key] = s
	}
	h.mu.Unlock()

	s.mu.Lock()
	s.client = sink
	s.detachedAt = time.Time{}
	// Warm reattach: replay only the delta each PTY produced past what the (now
	// re-bound) client was last sent — no duplication. A FRESH client (cold restore)
	// has delivered≈produced for these ids, so this is ~empty; it repaints via an
	// explicit pty.adopt instead. Then surface any exit that happened during the
	// outage. Ordering: data before exit, per PTY.
	for _, p := range s.ptys {
		p.replayFrom(sink, p.delivered)
		p.delivered = p.produced
		if p.exitPending != nil {
			_ = sink.send(exitHeader(p.id, p.exitPending.code, p.exitPending.signal), nil)
			delete(s.ptys, p.id)
		}
	}
	s.mu.Unlock()
	return s
}

// detach unbinds sink if it is still the live client (a later attach may have
// already replaced it). The session and its PTYs stay alive; the GC reaps them
// after detachTTL.
func (s *ptySession) detach(sink frameSink) {
	s.mu.Lock()
	if s.client == sink {
		s.client = nil
		s.detachedAt = time.Now()
		// Release adopt claims so the next restore (a fresh client) can re-adopt.
		for _, p := range s.ptys {
			p.claimed = false
		}
	}
	s.mu.Unlock()
}

// gcOnce reaps sessions detached longer than detachTTL (kills their PTYs). Called
// periodically by the GC loop; `now` is injected so tests need no real sleep.
func (h *SessionHost) gcOnce(now time.Time) {
	h.mu.Lock()
	var dead []*ptySession
	for key, s := range h.sessions {
		s.mu.Lock()
		idle := s.client == nil && !s.detachedAt.IsZero() && now.Sub(s.detachedAt) >= h.detachTTL
		s.mu.Unlock()
		if idle {
			dead = append(dead, s)
			delete(h.sessions, key)
		}
	}
	h.mu.Unlock()
	for _, s := range dead {
		s.killAll()
	}
}

// runGC periodically reaps idle sessions until Close.
func (h *SessionHost) runGC() {
	t := time.NewTicker(h.detachTTL / 4)
	defer t.Stop()
	for {
		select {
		case <-h.stopGC:
			return
		case <-t.C:
			h.gcOnce(time.Now())
		}
	}
}

// ---- a session --------------------------------------------------------------

// ptySession is one browser tab's durable PTY state, outliving any attach client.
type ptySession struct {
	key  string
	host *SessionHost

	mu         sync.Mutex
	ptys       map[int]*daemonPty
	client     frameSink // live attach client, nil when detached
	detachedAt time.Time
}

// daemonPty is one durable PTY child within a session. Output is kept in an
// always-rolling ring (the recent screen tail) so a FRESH client can repaint the
// terminal on cold restore (pty.adopt), while `delivered` tracks how far the
// current/last client has been sent so a WARM reattach replays only the missed
// delta (no duplication). All of ring/produced/delivered are guarded by sess.mu.
type daemonPty struct {
	id   int
	cmd  *exec.Cmd
	ptmx *os.File
	sess *ptySession

	ring      []byte // rolling tail of recent output (bounded by host.ringCap)
	produced  int64  // total bytes ever read from the PTY
	delivered int64  // produced-offset through which the live client has been sent

	cwd        string   // resolved cwd it was spawned in (for adopt matching)
	argv       []string // argv it was spawned with (for adopt matching)
	cols, rows int
	pid        int
	claimed    bool // adopted by the current client (prevents double-adopt in one restore)

	exitPending *ptyExit // set if the PTY exited while detached
	exited      atomic.Bool
}

type ptyExit struct {
	code, signal int
}

// ringBase is the absolute offset of ring[0].
func (pt *daemonPty) ringBase() int64 { return pt.produced - int64(len(pt.ring)) }

// replayFrom sends ring bytes covering [from, produced) to sink (clamped to the
// ring base if `from` has scrolled out). Caller holds sess.mu.
func (pt *daemonPty) replayFrom(sink frameSink, from int64) {
	base := pt.ringBase()
	if from < base {
		from = base
	}
	if from >= pt.produced {
		return
	}
	seg := pt.ring[from-base:]
	if len(seg) > 0 {
		_ = sink.send(dataHeader(pt.id), seg)
	}
}

// dispatch handles one request frame from the attached client. Spawn/write/
// resize/kill mirror the base PTY proxy; the spawn response and all pushes go
// through the session's live client (or its replay buffer).
func (s *ptySession) dispatch(h proxy.Header, payload []byte) {
	switch h.Method {
	case "pty.spawn":
		s.spawn(h, payload)
	case "pty.write":
		var p procIDParam
		_ = json.Unmarshal(h.Params, &p)
		if pt := s.get(p.ID); pt != nil && pt.ptmx != nil && !pt.exited.Load() && len(payload) > 0 {
			_, _ = pt.ptmx.Write(payload)
		}
		s.respondOK(h.ID)
	case "pty.resize":
		var p struct {
			ID   int `json:"id"`
			Cols int `json:"cols"`
			Rows int `json:"rows"`
		}
		_ = json.Unmarshal(h.Params, &p)
		if pt := s.get(p.ID); pt != nil && pt.ptmx != nil && !pt.exited.Load() {
			_ = pty.Setsize(pt.ptmx, &pty.Winsize{Rows: winDim(p.Rows), Cols: winDim(p.Cols)})
			s.mu.Lock()
			pt.cols, pt.rows = int(winDim(p.Cols)), int(winDim(p.Rows))
			s.mu.Unlock()
		}
		s.respondOK(h.ID)
	case "pty.kill":
		var p procIDParam
		_ = json.Unmarshal(h.Params, &p)
		if pt := s.get(p.ID); pt != nil && pt.cmd != nil && pt.cmd.Process != nil && !pt.exited.Load() {
			sig, ok := signalByNumber[p.Signal]
			if !ok {
				sig = syscall.SIGHUP
			}
			_ = pt.cmd.Process.Signal(sig)
		}
		s.respondOK(h.ID)
	}
}

// adoptForRestore reattaches a session-restore spawn to a still-running PTY whose
// (cwd, argv) match — preferring the requesting session, else any ORPHANED
// (detached) session, re-homing the PTY into the requester. Returns true if it
// adopted (and answered reqID); false if nothing matched (caller spawns fresh).
// Holds host.mu, so it serializes with attach/detach/GC — no client can attach or
// a session disappear mid-adopt.
func (h *SessionHost) adoptForRestore(req *ptySession, reqID int, cwd string, argv []string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	req.mu.Lock()
	pt := req.matchAdoptable(cwd, argv)
	req.mu.Unlock()
	owner := req
	if pt == nil {
		for _, s := range h.sessions {
			if s == req {
				continue
			}
			s.mu.Lock()
			if s.client == nil { // only steal from orphaned sessions, never a live tab
				pt = s.matchAdoptable(cwd, argv)
			}
			s.mu.Unlock()
			if pt != nil {
				owner = s
				break
			}
		}
	}
	if pt == nil {
		return false
	}
	return h.rehomeAndAdopt(pt, owner, req, reqID)
}

// rehomeAndAdopt moves pt from `owner` into `req` (if different), answers the
// restore spawn, and repaints from the full ring. Re-validates liveness under the
// lock (the PTY may have exited between the search and here). Only one re-home runs
// at a time (host.mu) and PTY delivery takes a single session lock, so there is no
// lock-order cycle.
func (h *SessionHost) rehomeAndAdopt(pt *daemonPty, owner, req *ptySession, reqID int) bool {
	owner.mu.Lock()
	if owner != req {
		req.mu.Lock()
		defer req.mu.Unlock()
	}
	defer owner.mu.Unlock()

	if pt.exited.Load() {
		return false // raced an exit; caller spawns fresh
	}
	if owner != req {
		delete(owner.ptys, pt.id)
		req.ptys[pt.id] = pt
		pt.sess = req // delivery/reap re-check picks up the new session
	}
	pt.claimed = true
	req.respondLocked(reqID, map[string]any{"id": pt.id, "pid": pt.pid, "adopted": true})
	if req.client != nil {
		pt.replayFrom(req.client, pt.ringBase())
		pt.delivered = pt.produced
	}
	return true
}

// matchAdoptable finds a live, unclaimed PTY in the session that was spawned with
// the same cwd and argv — the candidate a session-restore spawn should reattach to
// rather than spawning anew. Caller holds sess.mu.
func (s *ptySession) matchAdoptable(cwd string, argv []string) *daemonPty {
	for _, p := range s.ptys {
		if p.exited.Load() || p.claimed {
			continue
		}
		if p.cwd == cwd && sameStrv(p.argv, argv) {
			return p
		}
	}
	return nil
}

func sameStrv(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func (s *ptySession) get(id int) *daemonPty {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ptys[id]
}

// exitPendingSet reports whether the PTY exited while detached (buffered exit),
// reading under sess.mu so callers needn't touch daemonPty fields directly.
func (s *ptySession) exitPendingSet(id int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.ptys[id]
	return p != nil && p.exitPending != nil
}

func (s *ptySession) spawn(h proxy.Header, _ []byte) {
	var p spawnParams
	if err := json.Unmarshal(h.Params, &p); err != nil || len(p.Argv) == 0 {
		s.respondErr(h.ID, "pty.spawn: bad params")
		return
	}

	// Session restore: reattach to a still-running PTY matching (cwd, argv) — in this
	// session or an orphaned one (a closed tab) — instead of spawning. Repaints from
	// the full ring and resumes live delivery; the PTY's run goroutine never stopped.
	if p.Adopt {
		if s.host.adoptForRestore(s, h.ID, p.Cwd, p.Argv) {
			return
		}
		// No match anywhere (TTL-reaped / exited / never existed): spawn fresh.
	}

	cmd := exec.Command(p.Argv[0], p.Argv[1:]...)
	if p.Cwd != "" {
		cmd.Dir = p.Cwd
	}
	// The io-proxy has already resolved cwd against the jail and built the child
	// env (server PATH + $NVIM); we only guard TERM so a bare spawn still gets a
	// terminal type.
	cmd.Env = ensureTERM(envMapToList(p.Env))

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: winDim(p.Rows), Cols: winDim(p.Cols)})
	if err != nil {
		s.respondErr(h.ID, fmt.Sprintf("pty.spawn: %v", err))
		return
	}
	pt := &daemonPty{
		id: s.host.allocPtyID(), cmd: cmd, ptmx: ptmx, sess: s,
		cwd: p.Cwd, argv: p.Argv,
		cols: int(winDim(p.Cols)), rows: int(winDim(p.Rows)),
	}
	if cmd.Process != nil {
		pt.pid = cmd.Process.Pid
	}
	s.mu.Lock()
	s.ptys[pt.id] = pt
	s.mu.Unlock()

	s.respond(h.ID, map[string]any{"id": pt.id, "pid": pt.pid, "adopted": false})
	go pt.run()
}

// run streams PTY output then reaps the child, in ONE goroutine. Draining and
// reaping must be sequential: a PTY master returns all buffered output before it
// errors (EIO once the child's slave side closes), so reading to EOF guarantees
// the child's final bytes are delivered BEFORE we close the master and emit exit.
// (Closing the master from a separate reaper would race the drain and lose the
// terminal's tail — visible under `go test -race`.) Output is delivered live to
// the attached client, or appended to the bounded ring when detached (replayed on
// the next attach).
func (pt *daemonPty) run() {
	buf := make([]byte, 32*1024)
	for {
		n, rerr := pt.ptmx.Read(buf)
		if n > 0 {
			pt.deliver(buf[:n])
		}
		if rerr != nil {
			break
		}
	}
	pt.reap()
}

// deliver routes one output chunk, under sess.mu so the attach/detach boundary is
// race-free. The chunk always rolls into the bounded ring (the recent screen tail,
// kept for cold repaint); if a client is attached it is also sent live and the
// delivered offset advances. When detached it just accrues in the ring/produced,
// so a warm reattach replays exactly [delivered, produced) — no loss, no dup.
func (pt *daemonPty) deliver(b []byte) {
	// A PTY can be re-homed to another session (cold-restore adopt), so its ring is
	// always touched under its CURRENT session's lock: capture pt.sess, lock, and
	// retry if it changed under us (the re-home updates pt.sess while holding the
	// old lock, so a stale holder sees the change and retries).
	for {
		s := pt.sess
		s.mu.Lock()
		if pt.sess != s {
			s.mu.Unlock()
			continue
		}
		pt.ring = append(pt.ring, b...)
		if len(pt.ring) > s.host.ringCap {
			pt.ring = pt.ring[len(pt.ring)-s.host.ringCap:]
		}
		pt.produced += int64(len(b))
		if s.client != nil {
			_ = s.client.send(dataHeader(pt.id), b)
			pt.delivered = pt.produced
		}
		s.mu.Unlock()
		return
	}
}

// reap waits for the child (output already fully drained by run) and delivers
// pty.exit — live, or buffered until the next attach so the browser always learns
// the terminal ended.
func (pt *daemonPty) reap() {
	_ = pt.cmd.Wait()
	_ = pt.ptmx.Close()
	if !pt.exited.CompareAndSwap(false, true) {
		return
	}
	code, sig := exitStatus(pt.cmd.ProcessState)
	for {
		s := pt.sess
		s.mu.Lock()
		if pt.sess != s { // re-homed under us; retry with the current session
			s.mu.Unlock()
			continue
		}
		if s.client != nil {
			// Flush any undelivered tail, then the exit, then drop the PTY.
			pt.replayFrom(s.client, pt.delivered)
			pt.delivered = pt.produced
			_ = s.client.send(exitHeader(pt.id, code, sig), nil)
			delete(s.ptys, pt.id)
		} else {
			pt.exitPending = &ptyExit{code: code, signal: sig}
		}
		s.mu.Unlock()
		return
	}
}

// killAll SIGKILLs every PTY in the session (session reap / daemon shutdown).
func (s *ptySession) killAll() {
	s.mu.Lock()
	pts := make([]*daemonPty, 0, len(s.ptys))
	for _, p := range s.ptys {
		pts = append(pts, p)
	}
	s.ptys = map[int]*daemonPty{}
	s.mu.Unlock()
	for _, p := range pts {
		if !p.exited.Load() && p.cmd != nil && p.cmd.Process != nil {
			_ = p.cmd.Process.Kill()
		}
	}
}

// ---- response/push helpers (write through the live client) ------------------

func (s *ptySession) send(h proxy.Header, payload []byte) {
	s.mu.Lock()
	c := s.client
	s.mu.Unlock()
	if c != nil {
		_ = c.send(h, payload)
	}
}

func (s *ptySession) respond(id int, result any) {
	rj, _ := json.Marshal(result)
	s.send(proxy.Header{T: proxy.TRes, ID: id, OK: boolp(true), Result: rj}, nil)
}

// respondLocked writes a response directly to the live client; the caller already
// holds sess.mu (so it must not go through s.send, which re-locks).
func (s *ptySession) respondLocked(id int, result any) {
	if s.client == nil {
		return
	}
	rj, _ := json.Marshal(result)
	_ = s.client.send(proxy.Header{T: proxy.TRes, ID: id, OK: boolp(true), Result: rj}, nil)
}

func (s *ptySession) respondOK(id int) { s.respond(id, map[string]any{"ok": true}) }

func (s *ptySession) respondErr(id int, msg string) {
	s.send(proxy.Header{T: proxy.TRes, ID: id, OK: boolp(false), Error: msg}, nil)
}

func dataHeader(id int) proxy.Header {
	pb, _ := json.Marshal(map[string]any{"id": id})
	return proxy.Header{T: proxy.TPush, Method: "pty.data", Params: pb}
}

func exitHeader(id, code, signal int) proxy.Header {
	pb, _ := json.Marshal(map[string]any{"id": id, "code": code, "signal": signal})
	return proxy.Header{T: proxy.TPush, Method: "pty.exit", Params: pb}
}

func winDim(v int) uint16 {
	if v <= 0 {
		return 1
	}
	return uint16(v)
}

func envMapToList(m map[string]string) []string {
	if len(m) == 0 {
		return nil
	}
	out := make([]string, 0, len(m))
	for k, v := range m {
		out = append(out, k+"="+v)
	}
	return out
}

// ---- unix-socket transport --------------------------------------------------

// connSink writes frames to a net.Conn with length-prefixed framing (the same
// stdio framing the SSH-stdio transport uses), serializing concurrent writers
// (the read-loop's responses and the pump goroutines' pushes).
type connSink struct {
	rw *stdioFrameRW
	mu sync.Mutex
}

func (c *connSink) send(h proxy.Header, payload []byte) error {
	raw, err := proxy.Encode(h, payload)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.rw.writeRaw(raw)
}

// Serve runs the daemon: listen on the unix socket and serve attach clients until
// Close. The socket's parent dir must already exist with 0700 perms (single-user
// trust model — same as the loopback bind).
func (h *SessionHost) Serve(sockPath string) error {
	_ = os.Remove(sockPath) // clear a stale socket from a previous run
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		return err
	}
	defer ln.Close()
	go h.runGC()
	defer close(h.stopGC)
	for {
		c, err := ln.Accept()
		if err != nil {
			return nil // listener closed
		}
		go h.serveClient(c)
	}
}

// serveClient handles one attach connection: read the attach handshake, bind the
// client, dispatch requests, and detach on disconnect (keeping the session).
func (h *SessionHost) serveClient(c net.Conn) {
	defer c.Close()
	rw := &stdioFrameRW{r: bufio.NewReaderSize(c, 64*1024), w: c}
	sink := &connSink{rw: rw}

	// First frame is the attach handshake: THello with {session}.
	raw, err := rw.readRaw()
	if err != nil {
		return
	}
	hh, _, derr := proxy.Decode(raw)
	if derr != nil || hh.T != proxy.THello {
		return
	}
	var ap struct {
		Session string `json:"session"`
	}
	_ = json.Unmarshal(hh.Params, &ap)
	if ap.Session == "" {
		_ = sink.send(proxy.Header{T: proxy.TRes, ID: hh.ID, OK: boolp(false), Error: "attach: empty session"}, nil)
		return
	}
	// Ack BEFORE binding/replaying: attach() flushes buffered pty.data through the
	// sink, so binding first would put replay frames ahead of the ack on the wire
	// and the client would read a pty.data where it expects the handshake reply.
	ack, _ := json.Marshal(map[string]any{"attached": true, "session": ap.Session})
	_ = sink.send(proxy.Header{T: proxy.TRes, ID: hh.ID, OK: boolp(true), Result: ack}, nil)
	sess := h.attach(ap.Session, sink)
	defer sess.detach(sink)

	for {
		raw, err := rw.readRaw()
		if err != nil {
			return // attach client gone: session + PTYs stay alive
		}
		fh, payload, derr := proxy.Decode(raw)
		if derr != nil || fh.T != proxy.TReq {
			continue
		}
		sess.dispatch(fh, payload)
	}
}

// Close stops the GC loop (the listener is closed by the caller / process exit).
func (h *SessionHost) Close() {
	select {
	case <-h.stopGC:
	default:
		close(h.stopGC)
	}
}

// DebugSummary returns a human-readable snapshot of sessions and their live PTYs
// (keys, ids, cwd, argv). For tests/diagnostics only.
func (h *SessionHost) DebugSummary() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := ""
	for key, s := range h.sessions {
		s.mu.Lock()
		out += "session " + key + ":\n"
		for _, p := range s.ptys {
			out += fmt.Sprintf("  pty id=%d exited=%v cwd=%q argv=%v ring=%d\n",
				p.id, p.exited.Load(), p.cwd, p.argv, len(p.ring))
		}
		s.mu.Unlock()
	}
	return out
}

// DefaultDaemonSock is the per-user session-host socket path. It lives under
// $XDG_RUNTIME_DIR/rvim (the standard per-user runtime dir, tmpfs + 0700), with a
// /tmp/rvim-<uid> fallback. The same function runs on both sides (the daemon binds
// it, the io-proxy dials it), so they always agree.
func DefaultDaemonSock() string {
	dir := os.Getenv("XDG_RUNTIME_DIR")
	if dir != "" {
		dir = filepath.Join(dir, "rvim")
	} else {
		dir = filepath.Join(os.TempDir(), fmt.Sprintf("rvim-%d", os.Getuid()))
	}
	return filepath.Join(dir, "host.sock")
}

// RunSessionHost is the `rvim --session-host` entrypoint: a SINGLETON daemon. It
// takes an exclusive flock on a lock file beside the socket; if another daemon
// already holds it, this one exits cleanly (so racing io-proxies that each try to
// spawn a daemon converge on one). The held lock fd is intentionally leaked for
// the process lifetime.
func RunSessionHost(sockPath string) error {
	dir := filepath.Dir(sockPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	lockPath := sockPath + ".lock"
	lf, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	if err := syscall.Flock(int(lf.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		// Another daemon owns the lock — it is (or is becoming) the live one.
		lf.Close()
		return nil
	}
	// Lock held for the process lifetime (don't close lf).
	return NewSessionHost().Serve(sockPath)
}
