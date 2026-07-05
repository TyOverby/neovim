package server

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"tvim/proxy"
)

// SESSION CLIENT (stage 5 — durable PTYs, io-proxy side). When the io-proxy runs
// with a session key (`--serve-stdio --session <key>`, set by the app-server from
// the browser's stable per-tab id), its PTY traffic is delegated to the persistent
// `tvim --session-host` daemon instead of being handled in-process. fs/proc/sock
// stay local and per-connection (idempotent / re-triggerable, so the base teardown
// contract is correct for them); only PTYs need to outlive the connection.
//
// The daemonClient is a SELECTIVE relay: pty.* request frames go io-proxy -> daemon
// (with pty.spawn rewritten so the daemon stays policy-free — see forwardSpawn),
// and EVERY daemon -> io-proxy frame (the spawn response plus pty.data/pty.exit
// pushes, including the buffered output replayed on reattach) is forwarded verbatim
// to the browser. Because the daemon owns the PTY ids and survives reconnects, the
// browser's existing id mappings keep working across a drop with no browser change.

// daemonClient is the io-proxy's connection to the session-host daemon for one
// browser connection (one session).
type daemonClient struct {
	rw  *stdioFrameRW
	c   net.Conn
	wmu sync.Mutex
}

// connectDaemon dials the daemon (auto-spawning it if absent), performs the
// session attach handshake, and returns the client. selfExe is the path to this
// tvim binary (os.Executable) used to spawn the daemon.
func connectDaemon(sockPath, selfExe, session string) (*daemonClient, error) {
	c, err := dialOrSpawn(sockPath, selfExe)
	if err != nil {
		return nil, err
	}
	d := &daemonClient{rw: &stdioFrameRW{r: bufio.NewReaderSize(c, 64*1024), w: c}, c: c}

	params, _ := json.Marshal(map[string]string{"session": session})
	if err := d.send(proxy.Header{T: proxy.THello, ID: 0, Params: params}); err != nil {
		c.Close()
		return nil, err
	}
	// First frame back is the attach ack (the daemon sends it before any replay).
	raw, err := d.rw.readRaw()
	if err != nil {
		c.Close()
		return nil, err
	}
	ack, _, derr := proxy.Decode(raw)
	if derr != nil || ack.T != proxy.TRes || ack.OK == nil || !*ack.OK {
		c.Close()
		return nil, fmt.Errorf("session-host attach rejected")
	}
	return d, nil
}

func (d *daemonClient) send(h proxy.Header) error { return d.sendPayload(h, nil) }

func (d *daemonClient) sendPayload(h proxy.Header, payload []byte) error {
	raw, err := proxy.Encode(h, payload)
	if err != nil {
		return err
	}
	d.wmu.Lock()
	defer d.wmu.Unlock()
	return d.rw.writeRaw(raw)
}

// pump forwards every daemon frame verbatim to the browser connection until the
// daemon link drops. Runs for the life of the io-proxy connection.
func (d *daemonClient) pump(browser *conn) {
	for {
		raw, err := d.rw.readRaw()
		if err != nil {
			return
		}
		if err := browser.writeRawFrame(raw); err != nil {
			return
		}
	}
}

func (d *daemonClient) close() { _ = d.c.Close() }

// forward relays a browser pty.* request to the daemon. pty.spawn is rewritten so
// the daemon needs no jail/env policy; pty.write/resize/kill pass through with
// their payload. The browser's request id is preserved so the daemon's response
// correlates on the browser side.
func (d *daemonClient) forward(ctx *Ctx, h proxy.Header, payload []byte) {
	if h.Method == "pty.spawn" {
		d.forwardSpawn(ctx, h)
		return
	}
	_ = d.sendPayload(h, payload)
}

// forwardSpawn resolves the spawn cwd and builds the child env (server PATH +
// $NVIM) HERE — the io-proxy holds that policy/config — then forwards a spawn the
// daemon can exec directly.
func (d *daemonClient) forwardSpawn(ctx *Ctx, h proxy.Header) {
	var p spawnParams
	if err := json.Unmarshal(h.Params, &p); err != nil || len(p.Argv) == 0 {
		_ = d.sendPayload(h, nil) // let the daemon reject it uniformly
		return
	}
	cwd, err := resolveCwd(ctx.Config, p.Cwd)
	if err != nil {
		_ = ctx.conn.writeFrame(proxy.Header{T: proxy.TRes, ID: h.ID, OK: boolp(false), Error: err.Error()}, nil)
		return
	}
	// TVIM_ADOPT marker (set by the session-restore hook): ask the daemon to
	// reattach to a still-running PTY matching (resolved cwd, argv) rather than
	// spawn. Strip the marker so it never reaches the child's env.
	adopt := false
	if p.Env != nil {
		if _, ok := p.Env["TVIM_ADOPT"]; ok {
			adopt = true
			delete(p.Env, "TVIM_ADOPT")
		}
	}
	env := envListToMap(childEnv(p.Env, ctx.Config.NvimSocket))
	np, _ := json.Marshal(map[string]any{
		"argv": p.Argv, "cwd": cwd, "env": env, "cols": p.Cols, "rows": p.Rows, "adopt": adopt,
	})
	_ = d.sendPayload(proxy.Header{T: proxy.TReq, ID: h.ID, Method: "pty.spawn", Params: np}, nil)
}

func envListToMap(env []string) map[string]string {
	m := map[string]string{}
	for _, kv := range env {
		if i := indexByte(kv, '='); i >= 0 {
			m[kv[:i]] = kv[i+1:]
		}
	}
	return m
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

// ---- daemon bootstrap -------------------------------------------------------

// dialOrSpawn connects to the daemon, spawning it (detached) if the socket is
// absent/dead and retrying briefly. Concurrent io-proxies may each spawn one, but
// the daemon's flock singleton converges them on a single live process.
func dialOrSpawn(sockPath, selfExe string) (net.Conn, error) {
	if c, err := net.DialTimeout("unix", sockPath, 500*time.Millisecond); err == nil {
		return c, nil
	}
	if err := spawnDaemon(selfExe, sockPath); err != nil {
		return nil, err
	}
	// Poll for the daemon to come up.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if c, err := net.DialTimeout("unix", sockPath, 500*time.Millisecond); err == nil {
			return c, nil
		}
		time.Sleep(25 * time.Millisecond)
	}
	return nil, fmt.Errorf("session-host did not come up at %s", sockPath)
}

// spawnDaemon launches `tvim --session-host --daemon-sock <path>` fully detached
// (own session via Setsid, stdio to /dev/null) so it outlives this io-proxy and
// the SSH connection that started it.
func spawnDaemon(selfExe, sockPath string) error {
	cmd := exec.Command(selfExe, "--session-host", "--daemon-sock", sockPath)
	devnull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer devnull.Close()
	cmd.Stdin, cmd.Stdout, cmd.Stderr = devnull, devnull, devnull
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	// Reap our direct child so it doesn't linger as a zombie; the real daemon is
	// either this process (if it won the flock) or already running.
	go func() { _ = cmd.Wait() }()
	return nil
}
