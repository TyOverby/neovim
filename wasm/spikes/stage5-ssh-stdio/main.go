// Spike A — prove the stage-4 wire frame protocol round-trips over a child
// process's stdin/stdout, which is mechanically identical to the remote
// transport `ssh host rvim --serve-stdio` (ssh just puts an encrypted hop in
// front of the same two pipes). De-risks: (1) Go encode/decode matching the
// JS proxy-client wire format byte-for-byte, (2) framing a stream of
// length-prefixed frames out of a byte pipe (the read side must reassemble),
// (3) a binary payload trailer surviving the hop, (4) the new `hello` version
// check, (5) the new `cancel` frame aborting an in-flight request.
//
//   go run . parent    (default) — spawns `<self> child` and drives it
//   go run . child                — the --serve-stdio side, reads/answers frames
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"
)

// ---- wire frame: uint32LE headerLen | headerJSON | payloadBytes? ----
// Identical layout to wasm/proxy-client.js encodeFrame/decodeFrame.

type header struct {
	T       string          `json:"t"`                 // req|res|push|hello|cancel
	ID      int             `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	OK      *bool           `json:"ok,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   string          `json:"error,omitempty"`
	Version int             `json:"version,omitempty"` // hello
}

func writeFrame(w io.Writer, h header, payload []byte) error {
	hb, err := json.Marshal(h)
	if err != nil {
		return err
	}
	var lp [4]byte
	binary.LittleEndian.PutUint32(lp[:], uint32(len(hb)))
	if _, err := w.Write(lp[:]); err != nil {
		return err
	}
	if _, err := w.Write(hb); err != nil {
		return err
	}
	if len(payload) > 0 {
		if _, err := w.Write(payload); err != nil {
			return err
		}
	}
	return nil
}

// readFrame reassembles ONE frame from a stream. Unlike a WebSocket (message
// framing for free), a raw pipe is a byte stream, so the length prefix is what
// lets us re-slice frames back out. This is the part SSH-stdio newly requires.
func readFrame(r *bufio.Reader) (header, []byte, error) {
	var lp [4]byte
	if _, err := io.ReadFull(r, lp[:]); err != nil {
		return header{}, nil, err
	}
	hlen := binary.LittleEndian.Uint32(lp[:])
	hb := make([]byte, hlen)
	if _, err := io.ReadFull(r, hb); err != nil {
		return header{}, nil, err
	}
	var h header
	if err := json.Unmarshal(hb, &h); err != nil {
		return header{}, nil, err
	}
	// In a real protocol the payload length rides in the header (e.g. params.len
	// or a result byte count). For the spike we carry it explicitly so the reader
	// knows how many trailer bytes to pull.
	var plen int
	if h.Params != nil {
		var pm struct {
			PayloadLen int `json:"payloadLen"`
		}
		_ = json.Unmarshal(h.Params, &pm)
		plen = pm.PayloadLen
	}
	if h.Result != nil {
		var rm struct {
			PayloadLen int `json:"payloadLen"`
		}
		_ = json.Unmarshal(h.Result, &rm)
		if rm.PayloadLen > 0 {
			plen = rm.PayloadLen
		}
	}
	var payload []byte
	if plen > 0 {
		payload = make([]byte, plen)
		if _, err := io.ReadFull(r, payload); err != nil {
			return header{}, nil, err
		}
	}
	return h, payload, nil
}

// ---------------- child: the --serve-stdio io-proxy side ----------------
func runChild() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	var mu sync.Mutex // serialize concurrent writes to stdout
	send := func(h header, p []byte) {
		mu.Lock()
		defer mu.Unlock()
		_ = writeFrame(out, h, p)
		_ = out.Flush()
	}

	// Track cancellable in-flight work so a `cancel` frame can abort it.
	cancels := map[int]chan struct{}{}
	var cmu sync.Mutex

	for {
		h, payload, err := readFrame(in)
		if err != nil {
			return // pipe closed: remote hangup (the disconnect path)
		}
		switch h.T {
		case "hello":
			ok := true
			res := mustJSON(map[string]any{"serverVersion": protocolVersion})
			send(header{T: "res", ID: h.ID, OK: &ok, Result: res}, nil)
		case "req":
			switch h.Method {
			case "echo":
				// Bounce the binary payload straight back — proves the trailer
				// survives the stdio hop intact.
				ok := true
				res := mustJSON(map[string]any{"payloadLen": len(payload)})
				send(header{T: "res", ID: h.ID, OK: &ok, Result: res}, payload)
			case "slow":
				// A long op we can cancel mid-flight.
				done := make(chan struct{})
				cmu.Lock()
				cancels[h.ID] = done
				cmu.Unlock()
				go func(id int) {
					select {
					case <-time.After(5 * time.Second):
						ok := true
						send(header{T: "res", ID: id, OK: &ok,
							Result: mustJSON(map[string]any{"finished": true})}, nil)
					case <-done:
						ok := false
						send(header{T: "res", ID: id, OK: &ok, Error: "canceled"}, nil)
					}
					cmu.Lock()
					delete(cancels, id)
					cmu.Unlock()
				}(h.ID)
			}
		case "cancel":
			cmu.Lock()
			if ch, ok := cancels[h.ID]; ok {
				close(ch)
			}
			cmu.Unlock()
		}
	}
}

// ---------------- parent: drives a child over its stdio ----------------
func runParent() {
	self, _ := os.Executable()
	cmd := exec.Command(self, "child") // <- swap for: exec.Command("ssh", host, "rvim", "--serve-stdio")
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		fail("start child: %v", err)
	}
	out := bufio.NewWriter(stdin)
	in := bufio.NewReader(stdout)

	// Response demux: id -> waiting channel. Mirrors proxy-client's `pending`.
	type resp struct {
		h header
		p []byte
	}
	pending := map[int]chan resp{}
	var pmu sync.Mutex
	go func() {
		for {
			h, p, err := readFrame(in)
			if err != nil {
				// Pipe closed: reject ALL pending (the fail-fast contract).
				pmu.Lock()
				for id, ch := range pending {
					ch <- resp{h: header{T: "res", Error: "transport closed"}}
					delete(pending, id)
				}
				pmu.Unlock()
				return
			}
			if h.T == "res" {
				pmu.Lock()
				ch := pending[h.ID]
				delete(pending, h.ID)
				pmu.Unlock()
				if ch != nil {
					ch <- resp{h: h, p: p}
				}
			}
		}
	}()

	nextID := 1
	var wmu sync.Mutex
	call := func(h header, p []byte) chan resp {
		ch := make(chan resp, 1)
		pmu.Lock()
		pending[h.ID] = ch
		pmu.Unlock()
		wmu.Lock()
		_ = writeFrame(out, h, p)
		_ = out.Flush()
		wmu.Unlock()
		return ch
	}

	pass, failN := 0, 0
	check := func(name string, ok bool, detail string) {
		if ok {
			pass++
			fmt.Printf("  PASS %s\n", name)
		} else {
			failN++
			fmt.Printf("  FAIL %s — %s\n", name, detail)
		}
	}

	// 1) hello + version handshake
	id := nextID
	nextID++
	r := <-call(header{T: "hello", ID: id, Version: protocolVersion}, nil)
	var hres struct {
		ServerVersion int `json:"serverVersion"`
	}
	_ = json.Unmarshal(r.h.Result, &hres)
	check("hello handshake + version match", r.h.OK != nil && *r.h.OK && hres.ServerVersion == protocolVersion,
		fmt.Sprintf("serverVersion=%d", hres.ServerVersion))

	// 2) binary payload round-trips intact over stdio
	id = nextID
	nextID++
	payload := make([]byte, 64*1024)
	for i := range payload {
		payload[i] = byte(i * 7)
	}
	r = <-call(header{T: "req", ID: id, Method: "echo",
		Params: mustJSON(map[string]any{"payloadLen": len(payload)})}, payload)
	echoOK := len(r.p) == len(payload)
	if echoOK {
		for i := range payload {
			if r.p[i] != payload[i] {
				echoOK = false
				break
			}
		}
	}
	check("64KiB binary payload survives the stdio hop", echoOK,
		fmt.Sprintf("got %d bytes", len(r.p)))

	// 3) interleaved requests demux correctly by id (two in flight at once)
	idA, idB := nextID, nextID+1
	nextID += 2
	pa := []byte("AAAA")
	pb := []byte("BBBBBBBB")
	chA := call(header{T: "req", ID: idA, Method: "echo", Params: mustJSON(map[string]any{"payloadLen": len(pa)})}, pa)
	chB := call(header{T: "req", ID: idB, Method: "echo", Params: mustJSON(map[string]any{"payloadLen": len(pb)})}, pb)
	rb := <-chB
	ra := <-chA
	check("interleaved requests demux by id", string(ra.p) == "AAAA" && string(rb.p) == "BBBBBBBB",
		fmt.Sprintf("A=%q B=%q", ra.p, rb.p))

	// 4) cancel frame aborts an in-flight slow request promptly (no 5s wait)
	id = nextID
	nextID++
	start := time.Now()
	ch := call(header{T: "req", ID: id, Method: "slow"}, nil)
	time.Sleep(50 * time.Millisecond)
	_ = writeFrame(out, header{T: "cancel", ID: id}, nil)
	_ = out.Flush()
	r = <-ch
	elapsed := time.Since(start)
	check("cancel aborts in-flight request promptly", r.h.OK != nil && !*r.h.OK && r.h.Error == "canceled" && elapsed < time.Second,
		fmt.Sprintf("err=%q elapsed=%v", r.h.Error, elapsed))

	// 5) remote hangup rejects all pending (fail-fast, no hang)
	id = nextID
	nextID++
	ch = call(header{T: "req", ID: id, Method: "slow"}, nil)
	time.Sleep(50 * time.Millisecond)
	_ = stdin.Close()
	_ = cmd.Process.Kill() // simulate the SSH pipe dropping
	select {
	case r = <-ch:
		check("remote hangup fails in-flight op fast (no hang)", r.h.Error == "transport closed", r.h.Error)
	case <-time.After(2 * time.Second):
		check("remote hangup fails in-flight op fast (no hang)", false, "TIMED OUT — engine would hang")
	}

	_ = cmd.Wait()
	fmt.Printf("\nspike A: %d passed, %d failed\n", pass, failN)
	if failN > 0 {
		os.Exit(1)
	}
}

const protocolVersion = 1

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func fail(f string, a ...any) {
	fmt.Fprintf(os.Stderr, f+"\n", a...)
	os.Exit(1)
}

func main() {
	mode := "parent"
	if len(os.Args) > 1 {
		mode = os.Args[1]
	}
	switch mode {
	case "child":
		runChild()
	default:
		runParent()
	}
}
