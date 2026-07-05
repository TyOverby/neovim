package conformance

import (
	"context"
	"fmt"

	"tvim/server"
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
	srv := server.New(server.Config{Dir: root, Port: 0}, server.NewRegistry())
	if err := srv.Listen(); err != nil {
		return "", nil, err
	}
	go func() { _ = srv.Serve() }()
	url := fmt.Sprintf("ws://%s/proxy", srv.Addr())
	stop := func() { _ = srv.Close(context.Background()) }
	return url, stop, nil
}

// RemoteTarget runs the THREE-TIER path: an in-process app-server in relay mode
// (Config.RemoteCommand) forwards each WebSocket to a `tvim --serve-stdio`
// SUBPROCESS over its stdin/stdout — exercising the SSH-stdio transport (a local
// subprocess stands in for `ssh host …`; mechanically identical). The remote
// subprocess does all the IO. It is started IN the scenario's scratch dir (the
// sh wrapper's cd, standing in for the ssh login landing in the remote home) so
// the working dir it advertises — and spawn-cwd fallback — is `root`, matching
// the scenarios' on-disk assertions.
type RemoteTarget struct {
	Binary      string // path to the tvim binary (provides --serve-stdio)
	Implemented []string
}

func (RemoteTarget) Name() string     { return "remote-stdio" }
func (t RemoteTarget) Caps() []string { return t.Implemented }

func (t RemoteTarget) Start(root string) (string, func(), error) {
	srv := server.New(server.Config{
		Port: 0,
		RemoteCommand: []string{
			"sh", "-c",
			fmt.Sprintf(`cd '%s' && exec '%s' --serve-stdio "$@"`, root, t.Binary),
			"tvim",
		},
	}, server.NewRegistry())
	if err := srv.Listen(); err != nil {
		return "", nil, err
	}
	go func() { _ = srv.Serve() }()
	url := fmt.Sprintf("ws://%s/proxy", srv.Addr())
	stop := func() { _ = srv.Close(context.Background()) }
	return url, stop, nil
}
