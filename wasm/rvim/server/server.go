// Package server is the Go IO-proxy server (stage 5): it serves the static
// browser bundle over HTTP and speaks the framed proxy protocol over a /proxy
// WebSocket, dispatching to a handler registry. Phase 2 is the skeleton —
// transport + registry + hello/version + base handlers (ping/echo); the FS,
// process, PTY, and socket handler families register onto the same registry in
// later phases. It is the Go counterpart of wasm/server/server.js, verified
// against the same conformance suite.
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
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
	Root  string `json:"root"`
	Mount string `json:"mount"`
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

// ---- the websocket connection wrapper --------------------------------------

// conn serializes writes to a websocket (coder/websocket requires one writer at
// a time; responses and async pushes both write).
type conn struct {
	ws      *websocket.Conn
	writeMu sync.Mutex
}

func (cn *conn) writeFrame(h proxy.Header, payload []byte) error {
	frame, err := proxy.Encode(h, payload)
	if err != nil {
		return err
	}
	cn.writeMu.Lock()
	defer cn.writeMu.Unlock()
	return cn.ws.Write(context.Background(), websocket.MessageBinary, frame)
}

// ---- the server ------------------------------------------------------------

// Config configures a Server.
type Config struct {
	Bind        string       // listen address (default 127.0.0.1)
	Port        int          // listen port (0 = ephemeral)
	Root        string       // FS jail root (authoritative; a client hello cannot widen it)
	Mount       string       // in-editor mount prefix (default /host)
	Assets      *AssetServer // static bundle server (may be nil: no static serving)
	ProxyConfig bool         // generate /proxy-config.js so visiting == the standalone app
}

// Server serves HTTP + the /proxy WebSocket.
type Server struct {
	cfg Config
	reg *Registry
	ln  net.Listener
	srv *http.Server
}

// New builds a Server. The registry is shared across connections.
func New(cfg Config, reg *Registry) *Server {
	if cfg.Bind == "" {
		cfg.Bind = "127.0.0.1"
	}
	if cfg.Mount == "" {
		cfg.Mount = "/host"
	}
	s := &Server{cfg: cfg, reg: reg}
	s.srv = &http.Server{Handler: s.handler()}
	return s
}

func (s *Server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// The /proxy WebSocket endpoint.
		if r.URL.Path == "/proxy" {
			s.handleProxy(w, r)
			return
		}
		// /proxy-config.js: generate the standalone-app hook when proxying is on,
		// else a no-op 200 (the no-proxy demo) — mirrors serve.js/server.js.
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
	if !s.cfg.ProxyConfig {
		_, _ = w.Write([]byte("// no proxy: this Go server is serving the no-proxy demo.\n"))
		return
	}
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
	nvimSock := filepath.Join(os.TempDir(), fmt.Sprintf("rvim-nvim-%d-%d.sock", os.Getpid(), atomic.AddInt64(&nvimSockSeq, 1)))
	cfg := map[string]any{
		"url":        "ws://" + host + "/proxy",
		"mount":      s.cfg.Mount,
		"root":       s.cfg.Root,
		"nvimSocket": nvimSock,
	}
	cfgJSON, _ := json.Marshal(cfg)
	fmt.Fprintf(w, "// Generated by rvim: visiting this server == the standalone neovim.js app.\n"+
		"window.__NVIM_PROXY = %s;\n", cfgJSON)
}

func (s *Server) handleProxy(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"}, // loopback single-user model; auth gate is Phase 9
	})
	if err != nil {
		return
	}
	ws.SetReadLimit(1 << 24) // large file reads / pty bursts exceed the 32KiB default
	s.serveConn(ws)
}

func (s *Server) serveConn(ws *websocket.Conn) {
	cn := &conn{ws: ws}
	ctx := &Ctx{
		Config: ConnConfig{Root: s.cfg.Root, Mount: s.cfg.Mount},
		conn:   cn,
		state:  map[string]any{},
	}
	defer ctx.runCleanups()
	defer ws.Close(websocket.StatusNormalClosure, "")

	for {
		_, data, err := ws.Read(context.Background())
		if err != nil {
			return // connection dropped: cleanups run via defer
		}
		h, payload, derr := proxy.Decode(data)
		if derr != nil {
			continue // ignore undecodable noise
		}
		s.dispatch(cn, ctx, h, payload)
	}
}

func (s *Server) dispatch(cn *conn, ctx *Ctx, h proxy.Header, payload []byte) {
	switch h.T {
	case proxy.THello:
		// Merge the client's hello params (mount), then FORCE the server's root
		// back — a client-supplied root must never widen/relocate the jail.
		var cfg ConnConfig
		if len(h.Params) > 0 {
			_ = json.Unmarshal(h.Params, &cfg)
		}
		if cfg.Mount != "" {
			ctx.Config.Mount = cfg.Mount
		}
		if cfg.NvimSocket != "" {
			ctx.Config.NvimSocket = cfg.NvimSocket
		}
		ctx.Config.Root = s.cfg.Root // authoritative
		if h.Version != 0 && h.Version != proxy.ProtocolVersion {
			log.Printf("rvim: proxy protocol version mismatch: client=%d server=%d", h.Version, proxy.ProtocolVersion)
		}
		ack, _ := json.Marshal(map[string]any{
			"hello":         true,
			"config":        ctx.Config,
			"serverVersion": proxy.ProtocolVersion,
		})
		_ = cn.writeFrame(proxy.Header{T: proxy.TRes, ID: h.ID, OK: boolp(true), Result: ack}, nil)

	case proxy.TReq:
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
