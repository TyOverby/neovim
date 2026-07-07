package server

import (
	"sync"
	"testing"
)

// TestProcChildExitedRace guards audit finding A2: procChild.exited is touched by
// the reaper goroutine (markExited) AND by request handlers (procKill / procStdin
// / killAll) concurrently. It must be an atomic.Bool — before the fix these reads
// were unsynchronized and `go test -race` flagged a DATA RACE here. The two
// goroutines mirror the production accesses (the reaper's set vs a handler's read).
func TestProcChildExitedRace(t *testing.T) {
	rec := &procChild{}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { // reaper side
		defer wg.Done()
		for i := 0; i < 200000; i++ {
			rec.markExited()
			rec.exited.Store(false) // keep the write live across iterations
		}
	}()
	go func() { // handler side: the read procKill/procStdin do
		defer wg.Done()
		x := false
		for i := 0; i < 200000; i++ {
			x = x || rec.exited.Load()
		}
		_ = x
	}()
	wg.Wait()
}
