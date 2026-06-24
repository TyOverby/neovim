package conformance

import (
	"context"
	"os/exec"
	"testing"
)

// TestNodeReference runs the full conformance suite against the stage-4 Node
// reference server — the oracle the Go server (later phases) must also satisfy.
// Skips if `node` is unavailable.
func TestNodeReference(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not found; skipping conformance against the Node reference")
	}
	runAgainst(t, NodeTarget{})
}

func runAgainst(t *testing.T, target Target) {
	for _, sc := range Scenarios() {
		sc := sc
		t.Run(sc.Name, func(t *testing.T) {
			if err := RunScenario(context.Background(), target, sc); err != nil {
				t.Fatalf("[%s] %v", target.Name(), err)
			}
		})
	}
}
