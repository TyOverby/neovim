// Command rvim is the stage-5 standalone-app server (remote vim). Phase 2 is the
// skeleton: it serves the static browser bundle and the /proxy WebSocket with
// the base handlers (the FS/proc/PTY/socket families and the --remote SSH path
// arrive in later phases). It binds 127.0.0.1 by default — the load-bearing
// security default carried over from stage 4.
//
//	rvim --assets-dir <bundle> [--root DIR] [--port N] [--bind ADDR]
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
		port      = flag.Int("port", 8001, "listen port (0 = ephemeral)")
		bind      = flag.String("bind", "127.0.0.1", "listen address (non-loopback requires a token + TLS — Phase 9)")
		root      = flag.String("root", "", "filesystem jail root (default: cwd)")
		mount     = flag.String("mount", "/host", "in-editor mount prefix mapped to --root")
		assetsDir = flag.String("assets-dir", "", "serve the browser bundle from this dir (the build-site.sh output)")
		proxy     = flag.Bool("proxy", false, "generate /proxy-config.js so visiting the page is the standalone app")
		noOpen    = flag.Bool("no-open", false, "do not auto-open the browser (Phase 2: auto-open not yet wired)")
	)
	flag.Parse()
	_ = noOpen // auto-open lands in a later phase; the flag is accepted now.

	jailRoot := *root
	if jailRoot == "" {
		cwd, err := os.Getwd()
		if err != nil {
			log.Fatalf("rvim: cannot determine cwd: %v", err)
		}
		jailRoot = cwd
	}
	abs, err := filepath.Abs(jailRoot)
	if err != nil {
		log.Fatalf("rvim: bad --root: %v", err)
	}
	jailRoot = abs

	cfg := server.Config{
		Bind:        *bind,
		Port:        *port,
		Root:        jailRoot,
		Mount:       *mount,
		ProxyConfig: *proxy,
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
	fmt.Printf("  filesystem root : %s  (jail root; mount %s)\n", jailRoot, *mount)
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
