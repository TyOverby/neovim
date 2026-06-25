package conformance

import (
	"context"
	"testing"
)

// TestGoServer runs the conformance scenarios against the in-process Go server.
// These scenarios are the protocol spec (originally validated against the stage-4
// Node reference, since removed); they now run purely in-process — fast, no Node,
// no network — as the server's unit/contract layer beneath the browser e2e.
func TestGoServer(t *testing.T) {
	runAgainst(t, GoTarget{Implemented: []string{"base", "fs", "proc", "pty", "sock"}})
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
