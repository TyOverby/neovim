package conformance

import (
	"context"
	"fmt"
	"os"
	"time"
)

// ScenarioResult is the outcome of one scenario run.
type ScenarioResult struct {
	Name string
	OK   bool
	Err  error
}

// RunScenario starts a fresh target working in a fresh temp root, completes the
// hello handshake, and runs one scenario under a timeout. A fresh target per
// scenario keeps handle/child/socket id state and the filesystem isolated (the
// scenarios keep their file activity under `root`, their scratch dir).
func RunScenario(ctx context.Context, target Target, sc Scenario) error {
	root, err := os.MkdirTemp("", "rvim-conf-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(root)

	url, stop, err := target.Start(root)
	if err != nil {
		return fmt.Errorf("start target: %w", err)
	}
	defer stop()

	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	c, err := Dial(dctx, url)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer c.Close()

	if _, err := c.Hello(dctx, map[string]any{}); err != nil {
		return fmt.Errorf("hello: %w", err)
	}
	return sc.Run(dctx, c, root)
}

// RunAll runs every scenario against target, returning per-scenario results.
func RunAll(ctx context.Context, target Target) []ScenarioResult {
	var results []ScenarioResult
	for _, sc := range Scenarios() {
		err := RunScenario(ctx, target, sc)
		results = append(results, ScenarioResult{Name: sc.Name, OK: err == nil, Err: err})
	}
	return results
}
