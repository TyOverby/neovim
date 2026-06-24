package server

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

// SOCKET PROXY (stage 5 — the last IO seam). The Go port of
// wasm/server/sock-handlers.js (Node net+dns -> Go net):
//   sock.connect {host,port}|{path} -> {id}   (TCP or unix)
//   sock.write {id}+payload / sock.close {id}
//   sock.getaddrinfo {host,service} -> {addrs:[{family,address,port}]}
//   sock.listen {host,port}|{path} -> {listenerId,port}   (real bound port)
//   sock.accept {connId} / sock.listen_close {listenerId}
//   pushes: sock.connect_ok / sock.connect_err {id,code} / sock.data {id}+bytes /
//           sock.closed {id} / sock.incoming {listenerId,connId}
//
// SECURITY: outbound connect is the WHOLE POINT (reach the network), so the
// destination is not jailed — the server connects anywhere it can route, with
// its own privileges (consistent with the loopback-only bind + single-user
// model). Sockets + listeners are tracked per connection and destroyed when the
// ws drops.

type sockConn struct {
	id   int
	conn net.Conn

	mu          sync.Mutex
	connected   bool
	closed      bool
	accepted    bool
	readStarted bool
}

func (s *sockConn) closeOnce(fn func()) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.mu.Unlock()
	fn()
}

type sockListener struct {
	id      int
	ln      net.Listener
	pending map[int]*sockConn
	pendMu  sync.Mutex
}

type sockState struct {
	mu         sync.Mutex
	nextConn   int
	nextListen int
	conns      map[int]*sockConn
	listeners  map[int]*sockListener
	cleanupReg bool
}

func sockStateOf(c *Ctx) *sockState {
	st := c.State("sock", func() any {
		return &sockState{nextConn: 1, nextListen: 1, conns: map[int]*sockConn{}, listeners: map[int]*sockListener{}}
	}).(*sockState)
	st.mu.Lock()
	first := !st.cleanupReg
	st.cleanupReg = true
	st.mu.Unlock()
	if first {
		c.OnCleanup(func() { sockCleanup(st) })
	}
	return st
}

func (st *sockState) addConn(rec *sockConn) int {
	st.mu.Lock()
	defer st.mu.Unlock()
	id := st.nextConn
	st.nextConn++
	rec.id = id
	st.conns[id] = rec
	return id
}

func (st *sockState) getConn(id int) *sockConn {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.conns[id]
}

func (st *sockState) delConn(id int) {
	st.mu.Lock()
	delete(st.conns, id)
	st.mu.Unlock()
}

func sockCleanup(st *sockState) {
	st.mu.Lock()
	conns := make([]*sockConn, 0, len(st.conns))
	for _, r := range st.conns {
		conns = append(conns, r)
	}
	lns := make([]*sockListener, 0, len(st.listeners))
	for _, l := range st.listeners {
		lns = append(lns, l)
	}
	st.conns = map[int]*sockConn{}
	st.listeners = map[int]*sockListener{}
	st.mu.Unlock()
	for _, l := range lns {
		_ = l.ln.Close()
		l.pendMu.Lock()
		for _, r := range l.pending {
			if r.conn != nil {
				_ = r.conn.Close()
			}
		}
		l.pendMu.Unlock()
	}
	for _, r := range conns {
		if r.conn != nil && !r.closed {
			_ = r.conn.Close()
		}
	}
}

// RegisterSock installs the socket + DNS handlers onto reg.
func RegisterSock(reg *Registry) {
	reg.Register("sock.connect", sockConnect)
	reg.Register("sock.write", sockWrite)
	reg.Register("sock.close", sockClose)
	reg.Register("sock.getaddrinfo", sockGetaddrinfo)
	reg.Register("sock.listen", sockListen)
	reg.Register("sock.accept", sockAccept)
	reg.Register("sock.listen_close", sockListenClose)
}

type sockAddrParams struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	Path string `json:"path"`
}

func sockConnect(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	var p sockAddrParams
	if err := json.Unmarshal(params, &p); err != nil {
		return Response{}, err
	}
	isUnix := p.Path != ""
	var network, addr string
	if isUnix {
		network, addr = "unix", p.Path
	} else {
		host := p.Host
		if host == "" {
			host = "127.0.0.1"
		}
		if p.Port == 0 {
			return Response{}, errors.New("sock.connect: missing/invalid port")
		}
		network, addr = "tcp", net.JoinHostPort(host, strconv.Itoa(p.Port))
	}

	st := sockStateOf(c)
	rec := &sockConn{}
	id := st.addConn(rec)

	after := func() {
		conn, err := net.Dial(network, addr)
		if err != nil {
			rec.closeOnce(func() {
				c.Push("sock.connect_err", map[string]any{"id": id, "code": dialErrCode(err)}, nil)
			})
			return
		}
		rec.mu.Lock()
		rec.conn = conn
		rec.connected = true
		rec.mu.Unlock()
		if tcp, ok := conn.(*net.TCPConn); ok {
			_ = tcp.SetNoDelay(true)
		}
		c.Push("sock.connect_ok", map[string]any{"id": id}, nil)
		go sockReadLoop(c, rec)
	}
	return Response{Result: map[string]any{"id": id}, After: after}, nil
}

// sockReadLoop streams inbound bytes as sock.data, then sock.closed at EOF/error.
func sockReadLoop(c *Ctx, rec *sockConn) {
	buf := make([]byte, 32*1024)
	for {
		n, err := rec.conn.Read(buf)
		if n > 0 {
			c.Push("sock.data", map[string]any{"id": rec.id}, buf[:n])
		}
		if err != nil {
			rec.closeOnce(func() { c.Push("sock.closed", map[string]any{"id": rec.id}, nil) })
			return
		}
	}
}

func sockWrite(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	var p struct {
		ID int `json:"id"`
	}
	_ = json.Unmarshal(params, &p)
	if rec := sockStateOf(c).getConn(p.ID); rec != nil && rec.conn != nil && !rec.closed && len(payload) > 0 {
		_, _ = rec.conn.Write(payload)
	}
	return Response{Result: map[string]any{"ok": true}}, nil
}

func sockClose(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	var p struct {
		ID int `json:"id"`
	}
	_ = json.Unmarshal(params, &p)
	st := sockStateOf(c)
	if rec := st.getConn(p.ID); rec != nil {
		rec.mu.Lock()
		rec.closed = true
		rec.mu.Unlock()
		if rec.conn != nil {
			_ = rec.conn.Close()
		}
		st.delConn(p.ID)
	}
	return Response{Result: map[string]any{"ok": true}}, nil
}

func sockGetaddrinfo(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	var p struct {
		Host    string          `json:"host"`
		Service json.RawMessage `json:"service"`
	}
	_ = json.Unmarshal(params, &p)
	port := servicePort(strings.Trim(string(p.Service), `"`))
	host := strings.TrimSpace(p.Host)
	if host == "" {
		host = "127.0.0.1"
	}

	addrs := []map[string]any{}
	// A literal IP resolves trivially.
	if ip := net.ParseIP(host); ip != nil {
		addrs = append(addrs, ipAddr(ip, port))
		return Response{Result: map[string]any{"addrs": addrs}}, nil
	}
	ips, err := net.DefaultResolver.LookupIP(context.Background(), "ip", host)
	if err != nil || len(ips) == 0 {
		return Response{Result: map[string]any{"addrs": addrs}}, nil
	}
	for _, ip := range ips {
		addrs = append(addrs, ipAddr(ip, port))
	}
	return Response{Result: map[string]any{"addrs": addrs}}, nil
}

func ipAddr(ip net.IP, port int) map[string]any {
	family := 6
	if ip.To4() != nil {
		family = 4
	}
	return map[string]any{"family": family, "address": ip.String(), "port": port}
}

func sockListen(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	var p sockAddrParams
	if err := json.Unmarshal(params, &p); err != nil {
		return Response{}, err
	}
	isUnix := p.Path != ""
	var ln net.Listener
	var err error
	if isUnix {
		ln, err = net.Listen("unix", p.Path)
	} else {
		host := p.Host
		if host == "" {
			host = "127.0.0.1"
		}
		ln, err = net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(p.Port)))
	}
	if err != nil {
		return Response{}, err
	}

	st := sockStateOf(c)
	st.mu.Lock()
	listenerID := st.nextListen
	st.nextListen++
	lrec := &sockListener{id: listenerID, ln: ln, pending: map[int]*sockConn{}}
	st.listeners[listenerID] = lrec
	st.mu.Unlock()

	port := 0
	if tcp, ok := ln.Addr().(*net.TCPAddr); ok {
		port = tcp.Port
	}

	after := func() {
		go func() {
			for {
				conn, aerr := ln.Accept()
				if aerr != nil {
					return // listener closed
				}
				// New inbound connection: allocate a connId in the SHARED conn
				// table, DON'T read it yet (kernel buffers until accept — no data
				// lost), announce it.
				rec := &sockConn{conn: conn, connected: true}
				connID := st.addConn(rec)
				lrec.pendMu.Lock()
				lrec.pending[connID] = rec
				lrec.pendMu.Unlock()
				c.Push("sock.incoming", map[string]any{"listenerId": listenerID, "connId": connID}, nil)
			}
		}()
	}
	return Response{Result: map[string]any{"listenerId": listenerID, "port": port}, After: after}, nil
}

func sockAccept(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	var p struct {
		ConnID int `json:"connId"`
	}
	_ = json.Unmarshal(params, &p)
	st := sockStateOf(c)
	rec := st.getConn(p.ConnID)
	if rec != nil && rec.conn != nil {
		rec.mu.Lock()
		start := !rec.accepted && !rec.readStarted
		rec.accepted = true
		rec.readStarted = true
		rec.mu.Unlock()
		if start {
			// Drop it from any listener's pending set, then stream it.
			st.mu.Lock()
			for _, l := range st.listeners {
				l.pendMu.Lock()
				delete(l.pending, p.ConnID)
				l.pendMu.Unlock()
			}
			st.mu.Unlock()
			go sockReadLoop(c, rec)
		}
	}
	return Response{Result: map[string]any{"ok": true}}, nil
}

func sockListenClose(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	var p struct {
		ListenerID int `json:"listenerId"`
	}
	_ = json.Unmarshal(params, &p)
	st := sockStateOf(c)
	st.mu.Lock()
	lrec := st.listeners[p.ListenerID]
	delete(st.listeners, p.ListenerID)
	st.mu.Unlock()
	if lrec != nil {
		_ = lrec.ln.Close()
		lrec.pendMu.Lock()
		for cid, r := range lrec.pending {
			if r.conn != nil {
				_ = r.conn.Close()
			}
			st.delConn(cid)
		}
		lrec.pendMu.Unlock()
	}
	return Response{Result: map[string]any{"ok": true}}, nil
}

// servicePort maps a service (numeric string or named) to a port. Mirrors
// sock-handlers.js servicePort.
var namedServices = map[string]int{
	"http": 80, "https": 443, "ftp": 21, "ssh": 22, "telnet": 23, "smtp": 25,
	"domain": 53, "dns": 53, "pop3": 110, "imap": 143, "ldap": 389,
}

func servicePort(service string) int {
	service = strings.TrimSpace(service)
	if service == "" {
		return 0
	}
	if n, err := strconv.Atoi(service); err == nil {
		return n
	}
	return namedServices[strings.ToLower(service)]
}

// dialErrCode maps a dial error to the libuv-style code the wasm side expects.
func dialErrCode(err error) string {
	switch {
	case errors.Is(err, syscall.ECONNREFUSED):
		return "ECONNREFUSED"
	case errors.Is(err, syscall.ETIMEDOUT):
		return "ETIMEDOUT"
	case errors.Is(err, syscall.EHOSTUNREACH):
		return "EHOSTUNREACH"
	case errors.Is(err, syscall.ENETUNREACH):
		return "ENETUNREACH"
	case errors.Is(err, syscall.ENOENT):
		return "ENOENT"
	default:
		return "ECONNREFUSED"
	}
}
