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

// RemoteTarget runs the THREE-TIER path: an in-process app-server in relay mode
// (Config.RemoteCommand) forwards each WebSocket to a `rvim --serve-stdio`
// SUBPROCESS over its stdin/stdout — exercising the SSH-stdio transport (a local
// subprocess stands in for `ssh host …`; mechanically identical). The remote
// subprocess does all the IO, jailed to the same --root, so the scenarios'
// on-disk assertions hold.
type RemoteTarget struct {
	Binary      string // path to the rvim binary (provides --serve-stdio)
	Implemented []string
}

func (RemoteTarget) Name() string     { return "remote-stdio" }
func (t RemoteTarget) Caps() []string { return t.Implemented }

func (t RemoteTarget) Start(root string) (string, func(), error) {
	srv := server.New(server.Config{
		Root:          root,
		Port:          0,
		RemoteCommand: []string{t.Binary, "--serve-stdio", "--root", root},
	}, server.NewRegistry())
	if err := srv.Listen(); err != nil {
		return "", nil, err
	}
	go func() { _ = srv.Serve() }()
	url := fmt.Sprintf("ws://%s/proxy", srv.Addr())
	stop := func() { _ = srv.Close(context.Background()) }
	return url, stop, nil
}
