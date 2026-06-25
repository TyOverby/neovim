// Command rvim is the stage-5 standalone-app server (remote vim). It serves the
// static browser bundle and the /proxy WebSocket, performing the engine's real IO
// (filesystem, processes, PTYs, sockets) either LOCALLY or — with --remote — on a
// remote host over SSH. It binds 127.0.0.1 by default (the load-bearing security
// default carried over from stage 4).
//
//	rvim --assets-dir <bundle> [--root DIR] [--port N] [--bind ADDR] [--proxy]
//	rvim --remote user@host --root /remote/project --assets-dir <bundle> --proxy
//	rvim --serve-stdio --root DIR        (internal: the remote end of --remote)
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"rvim/server"
)

func main() {
	var (
		port        = flag.Int("port", 8001, "listen port (0 = ephemeral)")
		bind        = flag.String("bind", "127.0.0.1", "listen address (non-loopback requires a token + TLS — Phase 9)")
		root        = flag.String("root", "", "filesystem jail root (default: cwd; with --remote, the path ON the remote host)")
		mount       = flag.String("mount", "/host", "in-editor mount prefix mapped to --root")
		assetsDir   = flag.String("assets-dir", "", "serve the browser bundle from this dir (the build-site.sh output)")
		proxy       = flag.Bool("proxy", false, "generate /proxy-config.js so visiting the page is the standalone app")
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

	rootGiven := *root != ""
	jailRoot := *root
	if jailRoot == "" {
		cwd, err := os.Getwd()
		if err != nil {
			log.Fatalf("rvim: cannot determine cwd: %v", err)
		}
		jailRoot = cwd
	}
	// In --remote mode the root is a path on the REMOTE host, so don't Abs() it
	// against the LOCAL filesystem; otherwise resolve it locally.
	if *remote == "" {
		abs, err := filepath.Abs(jailRoot)
		if err != nil {
			log.Fatalf("rvim: bad --root: %v", err)
		}
		jailRoot = abs
	}

	// --serve-stdio: the remote endpoint. Speak the proxy protocol over stdin/
	// stdout; NOTHING goes to stdout except frames (logs go to stderr).
	if *serveStdio {
		selfExe, _ := os.Executable()
		srv := server.New(server.Config{
			Root: jailRoot, Mount: *mount,
			Session: *session, DaemonSock: *daemonSock, SelfExe: selfExe,
		}, server.NewRegistry())
		if err := srv.ServeStdio(os.Stdin, os.Stdout); err != nil {
			log.Fatalf("rvim --serve-stdio: %v", err)
		}
		return
	}

	cfg := server.Config{
		Bind:        *bind,
		Port:        *port,
		Root:        jailRoot,
		Mount:       *mount,
		ProxyConfig: *proxy,
	}
	if *remote != "" {
		// Relay mode: each /proxy connection runs `ssh -T <dest> rvim --serve-stdio
		// [--root <remote-root>]`. -T = no pseudo-tty (a tty would mangle the binary
		// frame protocol); BatchMode = never prompt (fail instead). The jail root is
		// a path on the REMOTE — so only forward --root when the user gave one. With
		// no --root, OMIT it and let the remote `--serve-stdio` default to the
		// remote's own cwd (your home dir over ssh). Passing the app-server's local
		// cwd here would name a directory that doesn't exist on the remote, leaving
		// the jail rooted at a missing path (every :e/:term then fails).
		cmd := []string{
			"ssh", "-T", "-o", "BatchMode=yes", *remote,
			*remoteRvim, "--serve-stdio", "--mount", *mount,
		}
		if rootGiven {
			cmd = append(cmd, "--root", *root)
		}
		cfg.RemoteCommand = cmd
		// The advisory root in /proxy-config.js describes the REMOTE; don't advertise
		// a local path. Empty when unspecified (the browser routes by --mount).
		cfg.Root = *root
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
		if rootGiven {
			fmt.Printf("  IO host        : %s  (ssh -T %s %s --serve-stdio --root %s)\n", *remote, *remote, *remoteRvim, *root)
			fmt.Printf("  remote root    : %s  (jail enforced ON the remote; mount %s)\n", *root, *mount)
		} else {
			fmt.Printf("  IO host        : %s  (ssh -T %s %s --serve-stdio)\n", *remote, *remote, *remoteRvim)
			fmt.Printf("  remote root    : <the remote's working dir>  (pass --root to choose; mount %s)\n", *mount)
		}
	} else {
		fmt.Printf("  filesystem root : %s  (jail root; mount %s)\n", jailRoot, *mount)
	}
	fmt.Printf("  bound to %s (loopback default; no token — single-user model)\n", *bind)
	if cfg.Assets == nil {
		fmt.Printf("  NOTE: no static bundle (pass --assets-dir <build-site.sh output>, or build with -tags embed_assets)\n")
	} else {
		fmt.Printf("  static bundle   : %s\n", assetSource)
	}
	if !*proxy {
		fmt.Printf("  NOTE: --proxy off; serving the no-proxy demo (Phase 2 has only base handlers)\n")
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
