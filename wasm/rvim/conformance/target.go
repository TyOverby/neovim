package conformance

import (
	"bufio"
	"fmt"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Target is a running server implementing the proxy protocol, started against a
// given filesystem jail root. Stop() shuts it down. The same scenarios run
// against any Target (the Node reference now; the Go server later).
type Target interface {
	// Start launches the server jailed to root and returns its /proxy WS URL.
	Start(root string) (url string, stop func(), err error)
	Name() string
}

// NodeTarget runs the stage-4 Node reference server (the conformance oracle) via
// node-target.js on an ephemeral loopback port.
type NodeTarget struct{}

func (NodeTarget) Name() string { return "node-reference" }

func (NodeTarget) Start(root string) (string, func(), error) {
	// Locate node-target.js relative to this source file so the harness works
	// regardless of the test's working directory.
	_, thisFile, _, _ := runtime.Caller(0)
	script := filepath.Join(filepath.Dir(thisFile), "node-target.js")

	cmd := exec.Command("node", script, "--root", root)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", nil, err
	}
	// Keep stdin open; node-target.js exits when it closes (so killing the
	// process — or the test ending — reaps it).
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return "", nil, err
	}
	cmd.Stderr = &prefixWriter{prefix: "[node-target] "}
	if err := cmd.Start(); err != nil {
		return "", nil, fmt.Errorf("start node-target: %w", err)
	}

	// Read the PORT= line.
	port := ""
	sc := bufio.NewScanner(stdout)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "PORT=") {
			port = strings.TrimPrefix(line, "PORT=")
			break
		}
	}
	if port == "" {
		_ = cmd.Process.Kill()
		return "", nil, fmt.Errorf("node-target did not report a PORT (node/ws installed?)")
	}

	stop := func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}
	return fmt.Sprintf("ws://127.0.0.1:%s/proxy", port), stop, nil
}

// prefixWriter tags subprocess stderr lines so failures are attributable.
type prefixWriter struct{ prefix string }

func (w *prefixWriter) Write(p []byte) (int, error) {
	for _, line := range strings.Split(strings.TrimRight(string(p), "\n"), "\n") {
		if line != "" {
			fmt.Println(w.prefix + line)
		}
	}
	return len(p), nil
}
