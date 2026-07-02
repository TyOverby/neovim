// Command rvim is the stage-5 standalone-app server (remote vim). It serves the
// static browser bundle and the /proxy WebSocket, performing the engine's real IO
// (filesystem, processes, PTYs, sockets) either LOCALLY or — with --remote — on a
// remote host over SSH. The IO host's filesystem is exposed WHOLE, mounted at the
// in-browser editor's root (the editor sees the box's real paths; site/rc files
// are MEMFS overlays on top). It binds 127.0.0.1 by default (the load-bearing
// security default carried over from stage 4).
//
//	rvim --assets-dir <bundle> [--port N] [--bind ADDR]
//	rvim --remote user@host --assets-dir <bundle>
//	rvim --serve-stdio                   (internal: the remote end of --remote)
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"rvim/server"
)

func main() {
	var (
		port        = flag.Int("port", 8001, "listen port (0 = ephemeral)")
		bind        = flag.String("bind", "127.0.0.1", "listen address (non-loopback requires a token + TLS — Phase 9)")
		assetsDir   = flag.String("assets-dir", "", "serve the browser bundle from this dir (the build-site.sh output)")
		rc          = flag.String("rc", "", "where the in-browser nvim's config/$HOME comes from: remote|local|builtin (default: remote with --remote, else builtin)")
		remote      = flag.String("remote", "", "ssh destination (user@host): proxy all IO to `ssh -T <dest> <remote-rvim> --serve-stdio`")
		remoteRvim  = flag.String("remote-rvim", "rvim", "path to rvim ON the remote host (like rsync's --rsync-path). `ssh host cmd` does NOT source ~/.bashrc, so the remote PATH usually excludes ~/bin — pass an absolute or ~/ path (the remote shell expands ~) if rvim isn't in the default PATH")
		serveStdio  = flag.Bool("serve-stdio", false, "(internal) run the io-proxy over stdin/stdout — the remote end of --remote")
		sessionHost = flag.Bool("session-host", false, "(internal) run the persistent session-host daemon for durable PTYs")
		session     = flag.String("session", "", "(internal) durable-PTY session key: delegate pty.* to the session-host daemon")
		daemonSock  = flag.String("daemon-sock", "", "(internal) session-host unix socket path (default: $XDG_RUNTIME_DIR/rvim/host.sock)")
		noOpen      = flag.Bool("no-open", false, "do not auto-open the browser (auto-open not yet wired)")
	)
	flag.Parse()
	_ = noOpen // auto-open lands in a later phase; the flag is accepted now.

	// --rc: where nvim's config/$HOME comes from. Default to remote when editing a
	// remote host (you almost always want the box's setup), else builtin (keep the
	// plain local demo config-free, as before).
	rcMode := *rc
	if rcMode == "" {
		if *remote != "" {
			rcMode = "remote"
		} else {
			rcMode = "builtin"
		}
	}
	switch rcMode {
	case "remote", "local", "builtin":
	default:
		log.Fatalf("rvim: invalid --rc %q (want remote|local|builtin)", *rc)
	}

	// --session-host: the durable-PTY daemon. Independent of any connection; owns
	// terminal shells so they survive transport drops. Singleton (flocked).
	if *sessionHost {
		sock := *daemonSock
		if sock == "" {
			sock = server.DefaultDaemonSock()
		}
		if err := server.RunSessionHost(sock); err != nil {
			log.Fatalf("rvim --session-host: %v", err)
		}
		return
	}

	// --serve-stdio: the remote endpoint. Speak the proxy protocol over stdin/
	// stdout; NOTHING goes to stdout except frames (logs go to stderr). Its cwd
	// (the ssh login dir, i.e. the remote home) is the working dir it advertises.
	if *serveStdio {
		selfExe, _ := os.Executable()
		srv := server.New(server.Config{
			Session: *session, DaemonSock: *daemonSock, SelfExe: selfExe,
		}, server.NewRegistry())
		if err := srv.ServeStdio(os.Stdin, os.Stdout); err != nil {
			log.Fatalf("rvim --serve-stdio: %v", err)
		}
		return
	}

	cfg := server.Config{
		Bind: *bind,
		Port: *port,
		RC:   rcMode,
	}
	if *remote != "" {
		// Relay mode: each /proxy connection runs `ssh -T <dest> rvim --serve-stdio`.
		// -T = no pseudo-tty (a tty would mangle the binary frame protocol);
		// BatchMode = never prompt (fail instead). All IO happens on the remote,
		// rooted at ITS filesystem; the working dir the editor lands in is the
		// remote process's cwd (your home dir over ssh).
		cfg.RemoteCommand = []string{
			"ssh", "-T", "-o", "BatchMode=yes", *remote,
			*remoteRvim, "--serve-stdio",
		}
	}
	// Static assets: an explicit --assets-dir (dev) wins; otherwise fall back to a
	// bundle embedded at build time (`-tags embed_assets`), so a release binary is
	// self-contained. With neither, the server runs without static serving.
	assetSource := ""
	if *assetsDir != "" {
		cfg.Assets = server.NewAssetServer(os.DirFS(*assetsDir))
		assetSource = "--assets-dir " + *assetsDir
	} else if fsys, ok := server.EmbeddedAssets(); ok {
		cfg.Assets = server.NewAssetServer(fsys)
		assetSource = "embedded bundle"
	}

	srv := server.New(cfg, server.NewRegistry())
	if err := srv.Listen(); err != nil {
		log.Fatalf("rvim: listen %s:%d: %v", *bind, *port, err)
	}

	url := fmt.Sprintf("http://%s/", srv.Addr())
	fmt.Printf("rvim standalone-app server on %s\n", url)
	fmt.Printf("  proxy WebSocket : %sproxy\n", "ws://"+srv.Addr()+"/")
	if *remote != "" {
		fmt.Printf("  IO host        : %s  (ssh -T %s %s --serve-stdio)\n", *remote, *remote, *remoteRvim)
		fmt.Printf("  filesystem     : the remote's, mounted at the editor's root; lands in the remote's working dir\n")
	} else {
		cwd, _ := os.Getwd()
		fmt.Printf("  filesystem     : this machine's, mounted at the editor's root; lands in %s\n", cwd)
	}
	switch rcMode {
	case "remote":
		fmt.Printf("  nvim config    : remote ($HOME is the IO host's home)\n")
	case "local":
		fmt.Printf("  nvim config    : local (this machine's ~/.config/nvim shadows the host's $HOME/.config/nvim)\n")
	default:
		fmt.Printf("  nvim config    : builtin (nvim defaults; no user config)\n")
	}
	fmt.Printf("  bound to %s (loopback default; no token — single-user model)\n", *bind)
	if cfg.Assets == nil {
		fmt.Printf("  NOTE: no static bundle (pass --assets-dir <build-site.sh output>, or build with -tags embed_assets)\n")
	} else {
		fmt.Printf("  static bundle   : %s\n", assetSource)
	}

	// Graceful shutdown on SIGINT/SIGTERM.
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		_ = srv.Close(context.Background())
	}()

	if err := srv.Serve(); err != nil {
		log.Fatalf("rvim: serve: %v", err)
	}
}
