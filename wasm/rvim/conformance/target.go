package conformance

// Target is a running server implementing the proxy protocol, started against a
// given filesystem jail root. Stop() shuts it down. The same scenarios run
// against any Target — currently the in-process Go server (GoTarget). (The
// stage-4 Node reference server was the original oracle but has been removed now
// that the Go server is the implementation; the scenarios remain the spec.)
type Target interface {
	// Start launches the server jailed to root and returns its /proxy WS URL.
	Start(root string) (url string, stop func(), err error)
	Name() string
	// Caps lists the capabilities the target implements ("base"/"fs"/"proc"/
	// "sock"/"pty"); nil means "all".
	Caps() []string
}
