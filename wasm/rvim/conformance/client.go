// Package conformance is the language-neutral protocol conformance harness: a
// Client that speaks the IO-proxy frame protocol over a transport, a set of
// scenarios that exercise every method, and a runner that asserts them against
// ANY target implementation. In stage 5 the stage-4 Node server is the reference
// oracle (NodeTarget); the Go server (later phases) must pass the SAME scenarios.
package conformance

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/coder/websocket"

	"rvim/proxy"
)

// Result is a decoded response frame.
type Result struct {
	ID      int
	OK      bool
	Result  json.RawMessage
	Error   string
	Payload []byte
}

// Into unmarshals the result JSON into v.
func (r Result) Into(v any) error {
	if len(r.Result) == 0 {
		return nil
	}
	return json.Unmarshal(r.Result, v)
}

// Push is an unsolicited server->client frame.
type Push struct {
	Method  string
	Params  json.RawMessage
	Payload []byte
}

// Into unmarshals the push params into v.
func (p Push) Into(v any) error {
	if len(p.Params) == 0 {
		return nil
	}
	return json.Unmarshal(p.Params, v)
}

// Client is a protocol client over a WebSocket transport. Safe for one caller
// goroutine issuing requests plus the internal read loop.
type Client struct {
	conn *websocket.Conn

	mu      sync.Mutex
	nextID  int
	pending map[int]chan Result
	closed  bool
	closErr error

	pushMu     sync.Mutex
	pushes     []Push
	pushSignal chan struct{}
}

// Dial connects to a target's /proxy WebSocket URL and starts the read loop.
func Dial(ctx context.Context, url string) (*Client, error) {
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", url, err)
	}
	conn.SetReadLimit(1 << 24) // payloads (file reads, pty bursts) exceed the 32KiB default
	c := &Client{
		conn:       conn,
		nextID:     1,
		pending:    map[int]chan Result{},
		pushSignal: make(chan struct{}, 1),
	}
	go c.readLoop()
	return c, nil
}

func (c *Client) readLoop() {
	for {
		_, data, err := c.conn.Read(context.Background())
		if err != nil {
			c.failAll(err)
			return
		}
		h, payload, derr := proxy.Decode(data)
		if derr != nil {
			continue // ignore undecodable noise
		}
		switch h.T {
		case proxy.TRes:
			c.mu.Lock()
			ch := c.pending[h.ID]
			delete(c.pending, h.ID)
			c.mu.Unlock()
			if ch != nil {
				ok := h.OK != nil && *h.OK
				ch <- Result{ID: h.ID, OK: ok, Result: h.Result, Error: h.Error, Payload: payload}
			}
		case proxy.TPush:
			c.pushMu.Lock()
			c.pushes = append(c.pushes, Push{Method: h.Method, Params: h.Params, Payload: payload})
			c.pushMu.Unlock()
			select {
			case c.pushSignal <- struct{}{}:
			default:
			}
		}
	}
}

func (c *Client) failAll(err error) {
	c.mu.Lock()
	c.closed = true
	c.closErr = err
	for id, ch := range c.pending {
		ch <- Result{ID: id, OK: false, Error: "transport closed: " + err.Error()}
		delete(c.pending, id)
	}
	c.mu.Unlock()
	// Wake any push waiters so they re-check (and observe closed).
	select {
	case c.pushSignal <- struct{}{}:
	default:
	}
}

func (c *Client) send(ctx context.Context, h proxy.Header, payload []byte) (chan Result, error) {
	frame, err := proxy.Encode(h, payload)
	if err != nil {
		return nil, err
	}
	var ch chan Result
	if h.T == proxy.TReq || h.T == proxy.THello {
		ch = make(chan Result, 1)
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			return nil, fmt.Errorf("client closed: %w", c.closErr)
		}
		c.pending[h.ID] = ch
		c.mu.Unlock()
	}
	if err := c.conn.Write(ctx, websocket.MessageBinary, frame); err != nil {
		if ch != nil {
			c.mu.Lock()
			delete(c.pending, h.ID)
			c.mu.Unlock()
		}
		return nil, err
	}
	return ch, nil
}

func (c *Client) newID() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	id := c.nextID
	c.nextID++
	return id
}

// Hello performs the handshake (with the protocol version) and returns the ack.
func (c *Client) Hello(ctx context.Context, params any) (Result, error) {
	id := c.newID()
	pb, err := json.Marshal(params)
	if err != nil {
		return Result{}, err
	}
	ch, err := c.send(ctx, proxy.Header{T: proxy.THello, ID: id, Params: pb, Version: proxy.ProtocolVersion}, nil)
	if err != nil {
		return Result{}, err
	}
	return waitResult(ctx, ch)
}

// Request sends a req frame and waits for its response.
func (c *Client) Request(ctx context.Context, method string, params any, payload []byte) (Result, error) {
	id := c.newID()
	pb, err := json.Marshal(params)
	if err != nil {
		return Result{}, err
	}
	ch, err := c.send(ctx, proxy.Header{T: proxy.TReq, ID: id, Method: method, Params: pb}, payload)
	if err != nil {
		return Result{}, err
	}
	return waitResult(ctx, ch)
}

func waitResult(ctx context.Context, ch chan Result) (Result, error) {
	select {
	case r := <-ch:
		return r, nil
	case <-ctx.Done():
		return Result{}, ctx.Err()
	}
}

// WaitPush blocks until an unconsumed push matching pred arrives (consuming it),
// or ctx is done. Pushes that arrived before the call are considered.
func (c *Client) WaitPush(ctx context.Context, pred func(Push) bool) (Push, error) {
	for {
		c.pushMu.Lock()
		for i, p := range c.pushes {
			if pred(p) {
				c.pushes = append(c.pushes[:i], c.pushes[i+1:]...)
				c.pushMu.Unlock()
				return p, nil
			}
		}
		c.pushMu.Unlock()
		select {
		case <-c.pushSignal:
		case <-ctx.Done():
			return Push{}, fmt.Errorf("waiting for push: %w", ctx.Err())
		}
	}
}

// PushMethod is a convenience predicate factory.
func PushMethod(method string) func(Push) bool {
	return func(p Push) bool { return p.Method == method }
}

// Close shuts the transport down.
func (c *Client) Close() error {
	return c.conn.Close(websocket.StatusNormalClosure, "")
}
