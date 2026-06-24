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

// TestGoServer runs the scenarios the Go server implements so far against the
// in-process Go server. The implemented-caps set grows each phase until it
// matches the Node oracle.
func TestGoServer(t *testing.T) {
	runAgainst(t, GoTarget{Implemented: []string{"base", "fs", "proc", "pty"}})
}

func runAgainst(t *testing.T, target Target) {
	scenarios := FilterByCaps(Scenarios(), target.Caps())
	if len(scenarios) == 0 {
		t.Fatalf("[%s] no scenarios match the target's caps %v", target.Name(), target.Caps())
	}
	for _, sc := range scenarios {
		sc := sc
		t.Run(sc.Name, func(t *testing.T) {
			if err := RunScenario(context.Background(), target, sc); err != nil {
				t.Fatalf("[%s] %v", target.Name(), err)
			}
		})
	}
}
