package server

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
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
func (h *SessionHost) attach(key, root string, sink frameSink) *ptySession {
	h.mu.Lock()
	s := h.sessions[key]
	if s == nil {
		s = &ptySession{key: key, host: h, root: root, ptys: map[int]*daemonPty{}}
		h.sessions[key] = s
	}
	h.mu.Unlock()

	s.mu.Lock()
	s.client = sink
	s.detachedAt = time.Time{}
	// Replay each live PTY's buffered output, then surface any exit that happened
	// during the outage. Ordering matters: data before exit, per PTY.
	for _, p := range s.ptys {
		if len(p.ring) > 0 {
			_ = sink.send(dataHeader(p.id), p.ring)
			p.ring = nil
		}
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
	root string // jail root from the first attach (informational)

	mu         sync.Mutex
	ptys       map[int]*daemonPty
	client     frameSink // live attach client, nil when detached
	detachedAt time.Time
}

// daemonPty is one durable PTY child within a session.
type daemonPty struct {
	id          int
	cmd         *exec.Cmd
	ptmx        *os.File
	sess        *ptySession
	ring        []byte   // output produced while detached (bounded, guarded by sess.mu)
	exitPending *ptyExit // set if the PTY exited while detached (guarded by sess.mu)
	exited      atomic.Bool
}

type ptyExit struct {
	code, signal int
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
	pt := &daemonPty{id: s.host.allocPtyID(), cmd: cmd, ptmx: ptmx, sess: s}
	s.mu.Lock()
	s.ptys[pt.id] = pt
	s.mu.Unlock()

	s.respond(h.ID, map[string]any{"id": pt.id})
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

// deliver routes one output chunk. Under sess.mu so the attach/detach boundary is
// race-free: a chunk is either sent live (client set) or ringed (client nil), and
// attach flushes the ring before any new live delivery — no loss, no duplication.
func (pt *daemonPty) deliver(b []byte) {
	s := pt.sess
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.client != nil {
		_ = s.client.send(dataHeader(pt.id), b)
		return
	}
	pt.appendRing(b, s.host.ringCap)
}

// appendRing appends to the replay buffer, dropping oldest bytes past cap.
func (pt *daemonPty) appendRing(b []byte, cap int) {
	pt.ring = append(pt.ring, b...)
	if len(pt.ring) > cap {
		pt.ring = pt.ring[len(pt.ring)-cap:]
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
	s := pt.sess
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.client != nil {
		// Flush any tail buffered before this exit, then the exit, then drop it.
		if len(pt.ring) > 0 {
			_ = s.client.send(dataHeader(pt.id), pt.ring)
			pt.ring = nil
		}
		_ = s.client.send(exitHeader(pt.id, code, sig), nil)
		delete(s.ptys, pt.id)
		return
	}
	pt.exitPending = &ptyExit{code: code, signal: sig}
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

	// First frame is the attach handshake: THello with {session, root}.
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
		Root    string `json:"root"`
	}
	_ = json.Unmarshal(hh.Params, &ap)
	if ap.Session == "" {
		_ = sink.send(proxy.Header{T: proxy.TRes, ID: hh.ID, OK: boolp(false), Error: "attach: empty session"}, nil)
		return
	}
	sess := h.attach(ap.Session, ap.Root, sink)
	ack, _ := json.Marshal(map[string]any{"attached": true, "session": ap.Session})
	_ = sink.send(proxy.Header{T: proxy.TRes, ID: hh.ID, OK: boolp(true), Result: ack}, nil)
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
