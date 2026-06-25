package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"

	"github.com/creack/pty"
)

// PTY PROXY (stage 5 — seam 2 + resize). The Go port of wasm/server/pty-handlers.js
// (node-pty -> creack/pty):
//   pty.spawn {argv,cwd,env,cols,rows} -> {id}
//   pty.write {id}+payload / pty.resize {id,cols,rows} / pty.kill {id,signal}
//   pushes: pty.data {id}+payload / pty.exit {id,code,signal}
//
// A :terminal child is ONE bidirectional pty — onData is the merged output,
// pty.write feeds input. cwd jailed to root; ptys killed when the connection
// drops.

type ptyRec struct {
	id     int
	cmd    *exec.Cmd
	ptmx   *os.File
	exited atomic.Bool // accessed from the reaper goroutine and request handlers
}

func (r *ptyRec) markExited() bool {
	return r.exited.CompareAndSwap(false, true)
}

type ptyTable struct {
	mu         sync.Mutex
	next       int
	byID       map[int]*ptyRec
	cleanupReg bool
}

func ptyTableOf(c *Ctx) *ptyTable {
	t := c.State("pty", func() any {
		return &ptyTable{next: 1, byID: map[int]*ptyRec{}}
	}).(*ptyTable)
	t.mu.Lock()
	first := !t.cleanupReg
	t.cleanupReg = true
	t.mu.Unlock()
	if first {
		c.OnCleanup(t.killAll)
	}
	return t
}

func (t *ptyTable) alloc(rec *ptyRec) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	id := t.next
	t.next++
	rec.id = id
	t.byID[id] = rec
	return id
}

func (t *ptyTable) get(id int) *ptyRec {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.byID[id]
}

func (t *ptyTable) killAll() {
	t.mu.Lock()
	recs := make([]*ptyRec, 0, len(t.byID))
	for _, r := range t.byID {
		recs = append(recs, r)
	}
	t.mu.Unlock()
	for _, r := range recs {
		if !r.exited.Load() && r.cmd != nil && r.cmd.Process != nil {
			_ = r.cmd.Process.Kill()
		}
	}
}

// RegisterPTY installs the PTY handlers onto reg.
func RegisterPTY(reg *Registry) {
	reg.Register("pty.spawn", ptySpawn)
	reg.Register("pty.write", ptyWrite)
	reg.Register("pty.resize", ptyResize)
	reg.Register("pty.kill", ptyKill)
}

func ptySpawn(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	var p spawnParams
	if err := json.Unmarshal(params, &p); err != nil {
		return Response{}, err
	}
	if len(p.Argv) == 0 {
		return Response{}, errors.New("pty.spawn: empty argv")
	}
	cwd, err := resolveCwd(c.Config, p.Cwd)
	if err != nil {
		return Response{}, err
	}

	cols := uint16(p.Cols)
	if cols == 0 {
		cols = 80
	}
	rows := uint16(p.Rows)
	if rows == 0 {
		rows = 24
	}

	cmd := exec.Command(p.Argv[0], p.Argv[1:]...)
	cmd.Dir = cwd
	cmd.Env = ensureTERM(childEnv(p.Env))

	// Start the pty NOW so a spawn failure becomes an error response (matching the
	// Node handler's throw), then stream + reap in After so pushes follow {id}.
	ptmx, serr := pty.StartWithSize(cmd, &pty.Winsize{Rows: rows, Cols: cols})
	if serr != nil {
		return Response{}, fmt.Errorf("pty.spawn: %v", serr)
	}
	rec := &ptyRec{cmd: cmd, ptmx: ptmx}
	id := ptyTableOf(c).alloc(rec)

	after := func() {
		go func() {
			buf := make([]byte, 32*1024)
			for {
				n, rerr := ptmx.Read(buf)
				if n > 0 {
					c.Push("pty.data", map[string]any{"id": id}, buf[:n])
				}
				if rerr != nil {
					return
				}
			}
		}()
		go func() {
			_ = cmd.Wait()
			_ = ptmx.Close()
			if rec.markExited() {
				code, sig := exitStatus(cmd.ProcessState)
				c.Push("pty.exit", map[string]any{"id": id, "code": code, "signal": sig}, nil)
			}
		}()
	}
	return Response{Result: map[string]any{"id": id}, After: after}, nil
}

func ptyWrite(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	var p procIDParam
	_ = json.Unmarshal(params, &p)
	if rec := ptyTableOf(c).get(p.ID); rec != nil && rec.ptmx != nil && !rec.exited.Load() && len(payload) > 0 {
		_, _ = rec.ptmx.Write(payload)
	}
	return Response{Result: map[string]any{"ok": true}}, nil
}

func ptyResize(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	var p struct {
		ID   int `json:"id"`
		Cols int `json:"cols"`
		Rows int `json:"rows"`
	}
	_ = json.Unmarshal(params, &p)
	if rec := ptyTableOf(c).get(p.ID); rec != nil && rec.ptmx != nil && !rec.exited.Load() {
		cols := uint16(p.Cols)
		if cols == 0 {
			cols = 1
		}
		rows := uint16(p.Rows)
		if rows == 0 {
			rows = 1
		}
		_ = pty.Setsize(rec.ptmx, &pty.Winsize{Rows: rows, Cols: cols})
	}
	return Response{Result: map[string]any{"ok": true}}, nil
}

func ptyKill(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	var p procIDParam
	_ = json.Unmarshal(params, &p)
	if rec := ptyTableOf(c).get(p.ID); rec != nil && rec.cmd != nil && rec.cmd.Process != nil && !rec.exited.Load() {
		sig, ok := signalByNumber[p.Signal]
		if !ok {
			sig = syscall.SIGHUP // node-pty's default when the number is unknown
		}
		_ = rec.cmd.Process.Signal(sig)
	}
	return Response{Result: map[string]any{"ok": true}}, nil
}

// ensureTERM appends a default TERM if the child env carries none (a pty needs a
// terminal type; node-pty defaults xterm-256color).
func ensureTERM(env []string) []string {
	for _, kv := range env {
		if strings.HasPrefix(kv, "TERM=") {
			return env
		}
	}
	return append(env, "TERM=xterm-256color")
}
