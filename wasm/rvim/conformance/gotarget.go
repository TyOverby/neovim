package conformance

import (
	"context"
	"fmt"

	"rvim/server"
)

// GoTarget runs the stage-5 Go server in-process on an ephemeral loopback port.
// It implements every capability; the conformance suite is its contract test.
type GoTarget struct {
	// Capabilities the Go server currently implements. Phase 2: base only.
	Implemented []string
}

func (GoTarget) Name() string     { return "go-server" }
func (t GoTarget) Caps() []string { return t.Implemented }

func (t GoTarget) Start(root string) (string, func(), error) {
	srv := server.New(server.Config{Root: root, Port: 0}, server.NewRegistry())
	if err := srv.Listen(); err != nil {
		return "", nil, err
	}
	go func() { _ = srv.Serve() }()
	url := fmt.Sprintf("ws://%s/proxy", srv.Addr())
	stop := func() { _ = srv.Close(context.Background()) }
	return url, stop, nil
}
