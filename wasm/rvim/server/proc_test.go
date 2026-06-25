package server

import (
	"sync"
	"testing"
)

// TestProcChildExitedRace demonstrates the data race on procChild.exited (audit
// finding A2): the reaper sets it under rec.mu (markExited), while procKill /
// procStdin / killAll read it WITHOUT the lock. Run under `go test -race` — it is
// flagged until `exited` is accessed atomically. The two goroutines mirror the
// production accesses exactly: a locked write (as in markExited) racing an
// unsynchronized read (as in procKill's `!rec.exited`).
func TestProcChildExitedRace(t *testing.T) {
	rec := &procChild{}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { // reaper side: locked write, as markExited does
		defer wg.Done()
		for i := 0; i < 200000; i++ {
			rec.mu.Lock()
			rec.exited = true
			rec.mu.Unlock()
		}
	}()
	go func() { // handler side: unsynchronized read, as procKill/procStdin do
		defer wg.Done()
		x := false
		for i := 0; i < 200000; i++ {
			x = x || rec.exited
		}
		_ = x
	}()
	wg.Wait()
}
