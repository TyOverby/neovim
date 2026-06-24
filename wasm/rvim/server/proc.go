package server

import (
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"sync"
)

// PROCESS PROXY (stage 5 — seam 2). The Go port of wasm/server/proc-handlers.js:
//   proc.spawn {argv,cwd,env,wantIn,wantOut,wantErr} -> {id}
//   proc.stdin {id}+payload / proc.stdin_close {id} / proc.kill {id,signal}
//   pushes: proc.stdout / proc.stdout_close / proc.stderr / proc.stderr_close /
//           proc.exit {id,code,signal}
//
// SECURITY: a spawn runs a REAL command with the server's privileges (the
// single-user model; 127.0.0.1 bind). The cwd is jailed to the root; children
// are tracked per connection and killed when the connection drops.

type procChild struct {
	id    int
	cmd   *exec.Cmd
	stdin io.WriteCloser

	mu     sync.Mutex
	exited bool
}

// markExited returns true exactly once (so proc.exit is pushed a single time).
func (r *procChild) markExited() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.exited {
		return false
	}
	r.exited = true
	return true
}

type procTable struct {
	mu         sync.Mutex
	next       int
	byID       map[int]*procChild
	cleanupReg bool
}

func procTableOf(c *Ctx) *procTable {
	t := c.State("proc", func() any {
		return &procTable{next: 1, byID: map[int]*procChild{}}
	}).(*procTable)
	// Register the disconnect cleanup once, outside the State init (which holds
	// the ctx lock OnCleanup also takes).
	t.mu.Lock()
	first := !t.cleanupReg
	t.cleanupReg = true
	t.mu.Unlock()
	if first {
		c.OnCleanup(t.killAll)
	}
	return t
}

func (t *procTable) alloc(rec *procChild) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	id := t.next
	t.next++
	rec.id = id
	t.byID[id] = rec
	return id
}

func (t *procTable) get(id int) *procChild {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.byID[id]
}

func (t *procTable) killAll() {
	t.mu.Lock()
	recs := make([]*procChild, 0, len(t.byID))
	for _, r := range t.byID {
		recs = append(recs, r)
	}
	t.mu.Unlock()
	for _, r := range recs {
		if !r.exited && r.cmd != nil && r.cmd.Process != nil {
			_ = r.cmd.Process.Kill()
		}
	}
}

// RegisterProc installs the process-spawn handlers onto reg.
func RegisterProc(reg *Registry) {
	reg.Register("proc.spawn", procSpawn)
	reg.Register("proc.stdin", procStdin)
	reg.Register("proc.stdin_close", procStdinClose)
	reg.Register("proc.kill", procKill)
}

func procSpawn(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	var p spawnParams
	if err := json.Unmarshal(params, &p); err != nil {
		return Response{}, err
	}
	if len(p.Argv) == 0 {
		return Response{}, errors.New("proc.spawn: empty argv")
	}
	cwd, err := resolveCwd(c.Config, p.Cwd)
	if err != nil {
		return Response{}, err
	}

	cmd := exec.Command(p.Argv[0], p.Argv[1:]...)
	cmd.Dir = cwd
	cmd.Env = childEnv(p.Env)

	rec := &procChild{cmd: cmd}
	if p.WantIn {
		if in, e := cmd.StdinPipe(); e == nil {
			rec.stdin = in
		}
	}
	var stdout, stderr io.ReadCloser
	if p.WantOut {
		stdout, _ = cmd.StdoutPipe()
	}
	if p.WantErr {
		stderr, _ = cmd.StderrPipe()
	}
	id := procTableOf(c).alloc(rec)

	// Start NOW (before the {id} response) so the child's pid exists by the time
	// the client can send proc.kill/proc.stdin. A missing binary (ENOENT) fails
	// here synchronously; we still return {id} and push exit 127 in After (after
	// the response), matching the Node handler's async 'error' -> exit-127.
	startErr := cmd.Start()

	after := func() {
		if startErr != nil {
			if rec.markExited() {
				c.Push("proc.exit", map[string]any{"id": id, "code": 127, "signal": 0}, nil)
			}
			return
		}
		// Drain stdout/stderr fully BEFORE Wait (Go closes the pipes on Wait, so
		// reading must complete first or trailing output is lost).
		var wg sync.WaitGroup
		if stdout != nil {
			wg.Add(1)
			go func() { defer wg.Done(); pumpProc(c, stdout, "proc.stdout", "proc.stdout_close", id) }()
		}
		if stderr != nil {
			wg.Add(1)
			go func() { defer wg.Done(); pumpProc(c, stderr, "proc.stderr", "proc.stderr_close", id) }()
		}
		go func() {
			wg.Wait()
			_ = cmd.Wait()
			if rec.markExited() {
				code, sig := exitStatus(cmd.ProcessState)
				c.Push("proc.exit", map[string]any{"id": id, "code": code, "signal": sig}, nil)
			}
		}()
	}
	return Response{Result: map[string]any{"id": id}, After: after}, nil
}

// pumpProc streams a child pipe as data pushes, then a close push at EOF.
func pumpProc(c *Ctx, r io.Reader, dataMethod, closeMethod string, id int) {
	buf := make([]byte, 32*1024)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			c.Push(dataMethod, map[string]any{"id": id}, buf[:n]) // Push copies the payload
		}
		if err != nil {
			c.Push(closeMethod, map[string]any{"id": id}, nil)
			return
		}
	}
}

type procIDParam struct {
	ID     int `json:"id"`
	Signal int `json:"signal"`
}

func procStdin(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	var p procIDParam
	_ = json.Unmarshal(params, &p)
	if rec := procTableOf(c).get(p.ID); rec != nil && rec.stdin != nil && !rec.exited {
		_, _ = rec.stdin.Write(payload)
	}
	return Response{Result: map[string]any{"ok": true}}, nil
}

func procStdinClose(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	var p procIDParam
	_ = json.Unmarshal(params, &p)
	if rec := procTableOf(c).get(p.ID); rec != nil && rec.stdin != nil {
		_ = rec.stdin.Close()
	}
	return Response{Result: map[string]any{"ok": true}}, nil
}

func procKill(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	var p procIDParam
	_ = json.Unmarshal(params, &p)
	if rec := procTableOf(c).get(p.ID); rec != nil && rec.cmd != nil && rec.cmd.Process != nil && !rec.exited {
		_ = rec.cmd.Process.Signal(toSignal(p.Signal))
	}
	return Response{Result: map[string]any{"ok": true}}, nil
}
