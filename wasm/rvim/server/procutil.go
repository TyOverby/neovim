package server

import (
	"os"
	"strings"
	"syscall"
)

// Shared spawn helpers for proc.spawn and pty.spawn (the Go port of the
// resolveCwd / childEnv / signal helpers in fs-handlers.js + proc-handlers.js).

// spawnParams is the common shape of a proc/pty spawn request.
type spawnParams struct {
	Argv    []string          `json:"argv"`
	Cwd     string            `json:"cwd"`
	Env     map[string]string `json:"env"`
	WantIn  bool              `json:"wantIn"`
	WantOut bool              `json:"wantOut"`
	WantErr bool              `json:"wantErr"`
	Cols    int               `json:"cols"`
	Rows    int               `json:"rows"`
}

// resolveCwd maps the engine's in-engine cwd to a real server path, the way the
// FS proxy maps file paths. The engine cwd is either under the mount prefix
// (-> <root>/<rest>), exactly the mount (-> root), or a MEMFS-only path with no
// server twin (-> root, NOT <root>/<that> which wouldn't exist — the bug that
// made :terminal fail while system() worked). Mirrors fs-handlers.js resolveCwd.
func resolveCwd(cfg ConnConfig, cwd string) (string, error) {
	root := cfg.Root
	mount := cfg.Mount
	if mount == "" {
		mount = "/host"
	}
	if cwd == "" {
		if root != "" {
			return root, nil
		}
		return os.Getwd()
	}
	if cwd == mount {
		return resolveJailed(root, "/")
	}
	if strings.HasPrefix(cwd, mount+"/") {
		return resolveJailed(root, cwd[len(mount):]) // keep the leading '/'
	}
	// A non-mount in-engine path (MEMFS): no server equivalent -> run in root.
	if root != "" {
		return resolveJailed(root, "/")
	}
	return os.Getwd()
}

// childEnv builds the child environment. The child runs on the SERVER, so it
// needs the SERVER's PATH to resolve bare commands (the shell `sh` that :! and
// :terminal exec) — the browser engine's synthetic PATH is useless here. Take
// the supplied env (else the server's) and APPEND the server PATH, so meaningful
// engine PATH entries still take precedence but server binaries always resolve.
//
// nvimSocket (the connection's $NVIM): the engine spawns most children with an
// inherited env, which the proxy can't carry from the browser, so $NVIM would be
// lost. We inject it here from the path nvim listens on (sent in the hello), so
// plugins / commands / :terminal can connect back to nvim over RPC like a normal
// nvim host. Mirrors fs-handlers.js childEnv (+ the $NVIM injection).
func childEnv(supplied map[string]string, nvimSocket string) []string {
	serverPath := os.Getenv("PATH")
	if serverPath == "" {
		serverPath = "/usr/bin:/bin"
	}
	envMap := map[string]string{}
	if supplied != nil {
		for k, v := range supplied {
			envMap[k] = v
		}
	} else {
		for _, kv := range os.Environ() {
			if i := strings.IndexByte(kv, '='); i >= 0 {
				envMap[kv[:i]] = kv[i+1:]
			}
		}
	}
	if p := envMap["PATH"]; p != "" {
		envMap["PATH"] = p + string(os.PathListSeparator) + serverPath
	} else {
		envMap["PATH"] = serverPath
	}
	if nvimSocket != "" {
		envMap["NVIM"] = nvimSocket
	}
	out := make([]string, 0, len(envMap))
	for k, v := range envMap {
		out = append(out, k+"="+v)
	}
	return out
}

// signalByNumber maps the numeric signal nvim sends to a syscall.Signal. nvim
// passes SIGTERM=15, SIGKILL=9, etc.
var signalByNumber = map[int]syscall.Signal{
	1:  syscall.SIGHUP,
	2:  syscall.SIGINT,
	3:  syscall.SIGQUIT,
	9:  syscall.SIGKILL,
	13: syscall.SIGPIPE,
	15: syscall.SIGTERM,
}

func toSignal(num int) syscall.Signal {
	if s, ok := signalByNumber[num]; ok {
		return s
	}
	return syscall.SIGTERM
}

// exitStatus extracts (code, signal) from a finished process, matching the Node
// proc.exit/pty.exit convention: a signaled exit reports signal (code 0); a
// normal exit reports its code (signal 0).
func exitStatus(ps *os.ProcessState) (code, signal int) {
	if ps == nil {
		return 0, 0
	}
	if ws, ok := ps.Sys().(syscall.WaitStatus); ok {
		if ws.Signaled() {
			return 0, int(ws.Signal())
		}
		return ws.ExitStatus(), 0
	}
	return ps.ExitCode(), 0
}
