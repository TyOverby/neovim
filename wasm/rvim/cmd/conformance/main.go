// Command conformance runs the IO-proxy protocol conformance suite against the
// in-process Go server and prints a pass/fail summary. It is the non-test entry
// point for the same scenarios `go test ./conformance` runs.
//
//	conformance            # run the full suite against the Go server
package main

import (
	"context"
	"fmt"
	"os"

	"rvim/conformance"
)

func main() {
	target := conformance.Target(conformance.GoTarget{
		Implemented: []string{"base", "fs", "proc", "pty", "sock"},
	})
	fmt.Printf("running conformance suite against: %s\n\n", target.Name())

	results := conformance.RunAll(context.Background(), target)
	failed := 0
	for _, r := range results {
		if r.OK {
			fmt.Printf("  PASS  %s\n", r.Name)
		} else {
			failed++
			fmt.Printf("  FAIL  %s\n        %v\n", r.Name, r.Err)
		}
	}
	fmt.Printf("\n%d passed, %d failed (%d total)\n", len(results)-failed, failed, len(results))
	if failed > 0 {
		os.Exit(1)
	}
}
