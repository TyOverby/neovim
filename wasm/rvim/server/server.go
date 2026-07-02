// Package server is the Go IO-proxy server (stage 5): it serves the static
// browser bundle over HTTP and speaks the framed proxy protocol over a /proxy
// WebSocket, dispatching to a handler registry. Phase 2 is the skeleton —
// transport + registry + hello/version + base handlers (ping/echo); the FS,
// process, PTY, and socket handler families register onto the same registry in
// later phases. It is the Go counterpart of wasm/server/server.js, verified
// against the same conformance suite.
package server

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/coder/websocket"

	"rvim/proxy"
)

// nvimSockSeq makes each generated $NVIM socket path unique per page load.
var nvimSockSeq int64

// ---- handler registry -------------------------------------------------------

// Response is what a handler returns: a JSON-able result plus an optional binary
// payload trailer. Mirrors the Node handler's `result | {result, payload}`.
//
// After, if set, runs AFTER the response frame is written — the ordering
// primitive that lets a spawn/connect handler return its {id} first and only
// then start emitting pushes (proc.exit, sock.connect_ok, …), so the client
// always learns the id before any push referencing it. Mirrors how the Node
// handlers return synchronously and fire events on a later tick.
type Response struct {
	Result  any
	Payload []byte
	After   func()
	// Deferred means the handler will send the response itself later (via
	// ctx.Respond/RespondErr) — dispatch sends nothing. Used by handlers that
	// block on slow work (DNS) so they don't stall the in-order read loop while
	// still preserving response correlation by id.
	Deferred bool
}

// HandlerFunc handles one request. Returning an error becomes an ok:false
// response carrying err.Error() (mirrors a Node handler throw).
type HandlerFunc func(c *Ctx, params json.RawMessage, payload []byte) (Response, error)

// Registry maps method -> handler. Built once, shared across connections.
type Registry struct {
	handlers map[string]HandlerFunc
}

// NewRegistry returns a registry preloaded with all implemented handler families
// (base + the IO seams). Mirrors createServer in wasm/server/server.js, which
// registers every handler family onto one registry.
func NewRegistry() *Registry {
	r := &Registry{handlers: map[string]HandlerFunc{}}
	registerBase(r)
	RegisterFS(r)   // seam 1: filesystem proxy
	RegisterProc(r) // seam 2: process spawn proxy
	RegisterPTY(r)  // seam 2: PTY proxy
	RegisterSock(r) // seam 3: TCP/unix sockets + DNS (outbound + inbound)
	return r
}

// Register adds (or replaces) a handler.
func (r *Registry) Register(method string, fn HandlerFunc) { r.handlers[method] = fn }

// ---- per-connection context -------------------------------------------------

// ConnConfig is the per-connection config established at hello.
type ConnConfig struct {
	// Dir is the io-proxy's working directory — the project dir rvim was started
	// in. It is advertised in the hello ack (the browser chdirs the editor into
	// it) and is the fallback cwd for spawns whose engine cwd has no server twin.
	Dir string `json:"dir"`
	// NvimSocket is the server-side path nvim listens on for RPC ($NVIM). The
	// server exports it into every spawned child's env so plugins/commands/
	// terminals can drive nvim over RPC, like a normal nvim host.
	NvimSocket string `json:"nvimSocket"`
}

// Ctx is the per-connection context handed to every handler. It carries the
// connection config, a Push for unsolicited server->client frames, lazily
// created per-connection state bags (handle/child/socket tables), and cleanup
// hooks run when the connection drops.
type Ctx struct {
	Config ConnConfig

	conn *conn

	// reqID is the id of the request currently being dispatched. Safe to read in
	// a handler body (dispatch is sequential per connection); a Deferred handler
	// captures it before spawning its async goroutine.
	reqID int

	// daemon, when set, delegates pty.* frames to the session-host daemon (durable
	// PTYs). Established once per connection in serveConn when a session key is
	// configured; nil means PTYs are handled locally (the base, non-durable path).
	daemon *daemonClient

	mu       sync.Mutex
	state    map[string]any
	cleanups []func()
}

// Respond sends a successful response for a Deferred handler.
func (c *Ctx) Respond(id int, result any, payload []byte) {
	var rj json.RawMessage
	if result != nil {
		if b, err := json.Marshal(result); err == nil {
			rj = b
		}
	}
	_ = c.conn.writeFrame(proxy.Header{T: proxy.TRes, ID: id, OK: boolp(true), Result: rj}, payload)
}

// RespondErr sends an error response for a Deferred handler.
func (c *Ctx) RespondErr(id int, msg string) {
	_ = c.conn.writeFrame(proxy.Header{T: proxy.TRes, ID: id, OK: boolp(false), Error: msg}, nil)
}

// ReqID returns the id of the request being dispatched (for Deferred handlers).
func (c *Ctx) ReqID() int { return c.reqID }

// Push sends an unsolicited push frame (stdout chunks, exit, socket data, …).
func (c *Ctx) Push(method string, params any, payload []byte) {
	pb, err := json.Marshal(params)
	if err != nil {
		return
	}
	_ = c.conn.writeFrame(proxy.Header{T: proxy.TPush, Method: method, Params: pb}, payload)
}

// State returns the per-connection state value for key, creating it with init on
// first use. Handlers use this for their handle/child/socket tables. The init
// runs under the ctx lock, so each table is created once per connection.
func (c *Ctx) State(key string, init func() any) any {
	c.mu.Lock()
	defer c.mu.Unlock()
	if v, ok := c.state[key]; ok {
		return v
	}
	v := init()
	c.state[key] = v
	return v
}

// OnCleanup registers a function to run when the connection drops (kill child
// processes, destroy sockets, close listeners — so a closed tab leaves nothing).
func (c *Ctx) OnCleanup(fn func()) {
	c.mu.Lock()
	c.cleanups = append(c.cleanups, fn)
	c.mu.Unlock()
}

func (c *Ctx) runCleanups() {
	c.mu.Lock()
	fns := c.cleanups
	c.cleanups = nil
	c.mu.Unlock()
	for _, fn := range fns {
		func() {
			defer func() { _ = recover() }()
			fn()
		}()
	}
}

// ---- the connection wrapper (transport-agnostic) ---------------------------

// conn carries the proxy protocol over a frameRW transport (a WebSocket for the
// browser, or stdin/stdout for the SSH-stdio remote — see transport.go). It
// serializes writes (responses + async pushes both write).
type conn struct {
	rw      frameRW
	writeMu sync.Mutex
}

func (cn *conn) writeFrame(h proxy.Header, payload []byte) error {
	raw, err := proxy.Encode(h, payload)
	if err != nil {
		return err
	}
	cn.writeMu.Lock()
	defer cn.writeMu.Unlock()
	return cn.rw.writeRaw(raw)
}

// writeRawFrame writes an already-encoded frame (used to forward session-host
// daemon frames to the browser verbatim), serialized with all other writers.
func (cn *conn) writeRawFrame(raw []byte) error {
	cn.writeMu.Lock()
	defer cn.writeMu.Unlock()
	return cn.rw.writeRaw(raw)
}

// readFrame returns the next decodable frame, skipping undecodable noise. It
// returns an error ONLY on a transport read failure (which ends the conn).
func (cn *conn) readFrame() (proxy.Header, []byte, error) {
	for {
		raw, err := cn.rw.readRaw()
		if err != nil {
			return proxy.Header{}, nil, err
		}
		h, payload, derr := proxy.Decode(raw)
		if derr != nil {
			continue // ignore undecodable noise
		}
		return h, payload, nil
	}
}

// ---- the server ------------------------------------------------------------

// Config configures a Server.
type Config struct {
	Bind   string       // listen address (default 127.0.0.1)
	Port   int          // listen port (0 = ephemeral)
	Assets *AssetServer // static bundle server (may be nil: no static serving)

	// Dir is the working directory advertised to the editor (the hello's `cwd`;
	// the browser chdirs into it on boot). Defaults to the process's cwd. The
	// server's filesystem is always exposed WHOLE, mounted at the engine's root —
	// there is no jail and no mount prefix.
	Dir string

	// RC selects where the in-browser nvim's config / $HOME comes from (stage 5
	// §5). One of "remote", "local", "builtin" (empty == "builtin"):
	//   remote  - $HOME points at the IO host's home (full live config + plugins
	//             from the box with your files). Advertised to the browser; the
	//             hello reports the host's home.
	//   local   - the app-server seeds its OWN ~/.config/nvim into the browser's
	//             MEMFS (config dir only; served at /rc-bundle.json).
	//   builtin - no external config; nvim's defaults (the prior behaviour).
	RC string

	// RemoteCommand, if set, puts the server in RELAY mode: it does NOT handle IO
	// locally — each /proxy WebSocket is relayed to a fresh subprocess (this argv)
	// that speaks the proxy protocol over its stdin/stdout. In production that's
	// `ssh -T <host> rvim --serve-stdio` (the three-tier architecture); tests use
	// a local `rvim --serve-stdio` subprocess.
	RemoteCommand []string

	// Session, if set, delegates this io-proxy's pty.* traffic to the session-host
	// daemon keyed by this id (durable PTYs across reconnects). DaemonSock is the
	// daemon's unix socket; SelfExe is this rvim binary (to auto-spawn the daemon).
	// These are set only on the --serve-stdio / local io-proxy side, never the
	// relay/app-server side.
	Session    string
	DaemonSock string
	SelfExe    string
}

// Server serves HTTP + the /proxy WebSocket.
type Server struct {
	cfg Config
	reg *Registry
	ln  net.Listener
	srv *http.Server

	connMu sync.Mutex
	conns  map[*conn]struct{} // live /proxy connections
}

// New builds a Server. The registry is shared across connections.
func New(cfg Config, reg *Registry) *Server {
	if cfg.Bind == "" {
		cfg.Bind = "127.0.0.1"
	}
	if cfg.Dir == "" {
		cfg.Dir, _ = os.Getwd()
	}
	s := &Server{cfg: cfg, reg: reg, conns: map[*conn]struct{}{}}
	s.srv = &http.Server{Handler: s.handler()}
	return s
}

// DropConnections abnormally closes every live /proxy connection (no close
// handshake), simulating a transport blip. The HTTP server stays up, so clients
// reconnect to it. Used to exercise the reconnect path.
func (s *Server) DropConnections() {
	s.connMu.Lock()
	cns := make([]*conn, 0, len(s.conns))
	for cn := range s.conns {
		cns = append(cns, cn)
	}
	s.connMu.Unlock()
	for _, cn := range cns {
		cn.rw.closeNow()
	}
}

func (s *Server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// The /proxy WebSocket endpoint.
		if r.URL.Path == "/proxy" {
			s.handleProxy(w, r)
			return
		}
		// /proxy-config.js: the standalone-app hook — visiting this server IS the
		// standalone app (proxying is always on).
		if r.URL.Path == "/proxy-config.js" {
			s.handleProxyConfig(w, r)
			return
		}
		if s.cfg.Assets != nil {
			s.cfg.Assets.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	})
	return mux
}

func (s *Server) handleProxyConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	host := r.Host
	if host == "" {
		host = fmt.Sprintf("127.0.0.1:%d", s.cfg.Port)
	}
	// Suggest a unique server-side path for nvim's RPC socket ($NVIM). The engine
	// can't pick a good server path itself (its filesystem is the browser's), and
	// the socket must live where server-side children — which inherit $NVIM — can
	// reach it. A server temp path is writable, off the user's project, and unique
	// per page load. The proxy binds unix paths literally, so $NVIM is the same on
	// both sides; the connection's cleanup removes the socket on disconnect.
	// The socket is bound where the io-proxy runs. In --remote mode that's the
	// REMOTE host, so os.TempDir() (this app-server's tmp — e.g. macOS's
	// /var/folders/…) would name a directory that doesn't exist there and the
	// bind fails ("connection refused" back in nvim). /tmp is portable across the
	// POSIX hosts the remote can be, so use it for remote; locally, os.TempDir().
	tmpBase := os.TempDir()
	if len(s.cfg.RemoteCommand) > 0 {
		tmpBase = "/tmp"
	}
	nvimSock := filepath.Join(tmpBase, fmt.Sprintf("rvim-nvim-%d-%d.sock", os.Getpid(), atomic.AddInt64(&nvimSockSeq, 1)))
	cfg := map[string]any{
		"url":        "ws://" + host + "/proxy",
		"nvimSocket": nvimSock,
		"rc":         s.rcMode(), // remote|local|builtin: where nvim's config/$HOME comes from
	}
	cfgJSON, _ := json.Marshal(cfg)
	fmt.Fprintf(w, "// Generated by rvim: visiting this server == the standalone neovim.js app.\n"+
		"window.__NVIM_PROXY = %s;\n", cfgJSON)
	// --rc local: inline this machine's ~/.config/nvim so app.js can seed it into
	// the browser MEMFS at create() time (config dir only; plugins/data are not
	// carried — use --rc remote for a full live setup). Loaded before app.js, so
	// it's available synchronously with no extra fetch.
	if bundle := s.localRCBundle(); bundle != nil {
		bundleJSON, _ := json.Marshal(bundle)
		fmt.Fprintf(w, "window.__NVIM_RC_FILES = %s;\n", bundleJSON)
	}
}

// rcBundleLimits bound the `--rc local` config seed so a stray large file (or a
// huge config tree) can't bloat the page load. Files over the per-file cap are
// skipped; collection stops at the total cap.
const (
	rcBundlePerFileMax = 2 << 20  // 2 MiB
	rcBundleTotalMax   = 16 << 20 // 16 MiB
)

// localRCBundle returns the app-server's own ~/.config/nvim as a map of
// { "<browser MEMFS path>": "<contents>" } for `--rc local` (embedded in
// /proxy-config.js and seeded into the browser via create({ filesystem })). nil
// in any other mode.
func (s *Server) localRCBundle() map[string]string {
	if s.rcMode() != "local" {
		return nil
	}
	home := serverHome()
	if home == "" {
		return nil
	}
	bundle := map[string]string{}
	collectRCBundle(filepath.Join(home, ".config", "nvim"), "/root/.config/nvim", bundle)
	return bundle
}

// collectRCBundle walks srcDir on the app-server's disk and fills dst with
// { destPrefix + "/" + rel : contents } for each regular file, honouring the
// per-file and total size caps. Best-effort: unreadable entries are skipped.
func collectRCBundle(srcDir, destPrefix string, dst map[string]string) {
	total := 0
	_ = filepath.WalkDir(srcDir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil //nolint:nilerr // skip unreadable entries, keep walking
		}
		if !d.Type().IsRegular() {
			return nil
		}
		info, err := d.Info()
		if err != nil || info.Size() > rcBundlePerFileMax {
			return nil
		}
		if total+int(info.Size()) > rcBundleTotalMax {
			return filepath.SkipAll
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return nil
		}
		rel, err := filepath.Rel(srcDir, p)
		if err != nil {
			return nil
		}
		dst[destPrefix+"/"+filepath.ToSlash(rel)] = string(data)
		total += len(data)
		return nil
	})
}

func (s *Server) handleProxy(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"}, // loopback single-user model; auth gate is Phase 9
	})
	if err != nil {
		return
	}
	ws.SetReadLimit(1 << 24) // large file reads / pty bursts exceed the 32KiB default
	// Durable-PTY session id: the browser mints a stable per-tab id and carries it
	// in ?session=. It routes this connection's :terminal shells to the session-host
	// daemon (on the IO host) so they survive a transport drop. Empty -> non-durable
	// PTYs (the base behaviour), e.g. a client that doesn't send one.
	session := r.URL.Query().Get("session")

	// RELAY mode (--remote): forward this connection to the remote io-proxy over
	// SSH stdio instead of handling IO locally — passing the session id through so
	// the REMOTE io-proxy attaches to the remote daemon.
	if len(s.cfg.RemoteCommand) > 0 {
		s.relayToRemote(ws, session)
		return
	}
	cn := &conn{rw: &wsFrameRW{ws: ws}}
	s.connMu.Lock()
	s.conns[cn] = struct{}{}
	s.connMu.Unlock()
	defer func() {
		s.connMu.Lock()
		delete(s.conns, cn)
		s.connMu.Unlock()
	}()
	s.serveConn(cn, session)
}

// serveConn runs the dispatch loop over a transport-agnostic conn. Used for the
// browser WebSocket and for the SSH-stdio remote (ServeStdio). session, when set,
// delegates this connection's pty.* to the session-host daemon (durable PTYs).
func (s *Server) serveConn(cn *conn, session string) {
	ctx := &Ctx{
		Config: ConnConfig{Dir: s.cfg.Dir},
		conn:   cn,
		state:  map[string]any{},
	}
	defer ctx.runCleanups()
	defer cn.rw.close()

	// Durable PTYs: when a session key is present, attach to the session-host daemon
	// and route pty.* through it. A setup failure falls back to local PTY handling
	// (non-durable) so terminals still work. The daemon link is closed when this
	// connection ends — the daemon KEEPS the session's shells running.
	if session != "" {
		sock := s.cfg.DaemonSock
		if sock == "" {
			sock = DefaultDaemonSock()
		}
		selfExe := s.cfg.SelfExe
		if selfExe == "" {
			selfExe, _ = os.Executable()
		}
		if d, err := connectDaemon(sock, selfExe, session); err != nil {
			log.Printf("rvim: session-host attach failed (%v); PTYs are non-durable this session", err)
		} else {
			ctx.daemon = d
			go d.pump(cn)
			defer d.close()
		}
	}

	for {
		h, payload, err := cn.readFrame()
		if err != nil {
			return // transport dropped: cleanups run via defer
		}
		s.dispatch(cn, ctx, h, payload)
	}
}

// ServeStdio runs the io-proxy over a stdin/stdout pipe (the `--serve-stdio`
// remote endpoint of the three-tier --remote architecture). One connection;
// returns when stdin closes (the SSH pipe dropped). The session key comes from the
// --session flag (relayed by the app-server from the browser's ?session=).
func (s *Server) ServeStdio(in io.Reader, out io.Writer) error {
	cn := &conn{rw: &stdioFrameRW{r: bufio.NewReaderSize(in, 64*1024), w: out}}
	s.serveConn(cn, s.cfg.Session)
	return nil
}

func (s *Server) dispatch(cn *conn, ctx *Ctx, h proxy.Header, payload []byte) {
	switch h.T {
	case proxy.THello:
		// Merge the client's hello params (nvimSocket); everything else about the
		// connection (dir) is the server's to report.
		var cfg ConnConfig
		if len(h.Params) > 0 {
			_ = json.Unmarshal(h.Params, &cfg)
		}
		if cfg.NvimSocket != "" {
			ctx.Config.NvimSocket = cfg.NvimSocket
		}
		if h.Version != 0 && h.Version != proxy.ProtocolVersion {
			log.Printf("rvim: proxy protocol version mismatch: client=%d server=%d", h.Version, proxy.ProtocolVersion)
		}
		ack, _ := json.Marshal(map[string]any{
			"hello":         true,
			"config":        ctx.Config,
			"serverVersion": proxy.ProtocolVersion,
			// The user the io-proxy process runs as — the "accessed" user. Under
			// --remote this handler runs in the remote `--serve-stdio` process (the
			// relay forwards the hello untouched), so it reports the REMOTE user; in
			// the local case it's the local user. The browser exposes it as $USER.
			"user": serverUser(),
			// The io-proxy process's home + working dir. The server's filesystem is
			// mounted at the engine's root, so both are directly usable in-editor:
			// the browser uses home as $HOME (`--rc remote`/`local`) and chdirs the
			// editor into cwd on boot.
			"home": serverHome(),
			"cwd":  ctx.Config.Dir,
		})
		_ = cn.writeFrame(proxy.Header{T: proxy.TRes, ID: h.ID, OK: boolp(true), Result: ack}, nil)

	case proxy.TReq:
		// Durable PTYs: when a session-host daemon is attached, pty.* requests are
		// forwarded to it (and its responses/pushes are pumped back to the browser),
		// instead of the local per-connection PTY handlers. Everything else (fs /
		// proc / sock) stays local.
		if ctx.daemon != nil && strings.HasPrefix(h.Method, "pty.") {
			ctx.daemon.forward(ctx, h, payload)
			return
		}
		fn := s.reg.handlers[h.Method]
		if fn == nil {
			_ = cn.writeFrame(proxy.Header{T: proxy.TRes, ID: h.ID, OK: boolp(false),
				Error: fmt.Sprintf("unknown method '%s'", h.Method)}, nil)
			return
		}
		// Dispatch SYNCHRONOUSLY, in frame order. This is load-bearing: streaming
		// writes (pty.write / proc.stdin / sock.write) MUST be applied in the order
		// they arrived — a per-request goroutine would reorder rapid keystrokes and
		// scramble terminal input. Handlers that block on slow work don't stall the
		// loop because they defer it: network connect/accept/listen stream via
		// After (goroutines), and DNS uses Response.Deferred. fs ops are fast local
		// I/O. (Matches the Node server's single-threaded in-order semantics.)
		ctx.reqID = h.ID
		resp, err := callHandler(fn, ctx, h.Params, payload)
		if err != nil {
			_ = cn.writeFrame(proxy.Header{T: proxy.TRes, ID: h.ID, OK: boolp(false), Error: err.Error()}, nil)
			return
		}
		if resp.Deferred {
			return // the handler will Respond/RespondErr itself when its async work finishes
		}
		var resultJSON json.RawMessage
		if resp.Result != nil {
			b, mErr := json.Marshal(resp.Result)
			if mErr != nil {
				_ = cn.writeFrame(proxy.Header{T: proxy.TRes, ID: h.ID, OK: boolp(false), Error: mErr.Error()}, nil)
				return
			}
			resultJSON = b
		}
		_ = cn.writeFrame(proxy.Header{T: proxy.TRes, ID: h.ID, OK: boolp(true), Result: resultJSON}, resp.Payload)
		// Ordering primitive: pushes referencing the just-returned id (exit,
		// connect_ok, …) run only after the response is on the wire — guaranteed
		// because the response is written above, BEFORE After is invoked. After
		// runs in a goroutine so a blocking body (e.g. sock.connect's net.Dial)
		// never stalls the in-order read loop; the handler body already did the
		// order-sensitive work synchronously.
		if resp.After != nil {
			go resp.After()
		}

	case proxy.TCancel:
		// Phase 6 wires real cancellation; for now there is nothing long-lived to
		// abort (handlers complete quickly or stream via pushes).
	}
}

// callHandler isolates a handler panic into an error response.
func callHandler(fn HandlerFunc, ctx *Ctx, params json.RawMessage, payload []byte) (resp Response, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("handler panic: %v", r)
		}
	}()
	return fn(ctx, params, payload)
}

func boolp(b bool) *bool { return &b }

// serverUser reports the username this io-proxy process runs as — the user
// "being accessed" through the proxy. It is sent in the hello ack so the browser
// engine can expose it as $USER (instead of the hardcoded "web"). user.Current()
// is the source of truth; fall back to $USER/$LOGNAME (e.g. a static build with
// no /etc/passwd entry), and to "" if nothing is known (the browser then keeps
// its default).
func serverUser() string {
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

// serverHome reports the home directory of the io-proxy process. os.UserHomeDir
// honours $HOME (so it's correct over ssh and overridable in tests); the passwd
// entry is the fallback.
func serverHome() string {
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		return h
	}
	if u, err := user.Current(); err == nil && u.HomeDir != "" {
		return u.HomeDir
	}
	return ""
}

// rcMode normalises Config.RC to one of remote|local|builtin (empty -> builtin).
func (s *Server) rcMode() string {
	switch s.cfg.RC {
	case "remote", "local":
		return s.cfg.RC
	default:
		return "builtin"
	}
}

// ---- lifecycle --------------------------------------------------------------

// Listen binds the configured address (storing the listener so Addr works for
// ephemeral ports) without serving yet.
func (s *Server) Listen() error {
	ln, err := net.Listen("tcp", fmt.Sprintf("%s:%d", s.cfg.Bind, s.cfg.Port))
	if err != nil {
		return err
	}
	s.ln = ln
	if tcp, ok := ln.Addr().(*net.TCPAddr); ok {
		s.cfg.Port = tcp.Port
	}
	return nil
}

// Serve serves until the server is closed (blocking). Listen must be called first.
func (s *Server) Serve() error {
	if s.ln == nil {
		if err := s.Listen(); err != nil {
			return err
		}
	}
	err := s.srv.Serve(s.ln)
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

// Addr returns the bound address (valid after Listen).
func (s *Server) Addr() string {
	if s.ln == nil {
		return ""
	}
	return s.ln.Addr().String()
}

// Port returns the bound port (valid after Listen).
func (s *Server) Port() int { return s.cfg.Port }

// Close shuts the server down.
func (s *Server) Close(ctx context.Context) error { return s.srv.Shutdown(ctx) }
