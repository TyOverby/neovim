// TestBrowserPerfTrack verifies the engine worker's IO-proxy performance
// instrumentation (wasm/web/src/engine-worker.ts, instrumentProxyPerf): every
// proxied IO request lands in the WORKER's User Timing buffer as a
// performance.measure tagged for the DevTools "IO proxy" custom track
// (detail.devtools dataType:'track-entry'), a failing request is colored
// 'error', and one-shot events (server pushes, connection status) are
// performance.marks tagged dataType:'marker'.
//
// The entries live in the dedicated worker, not the page, so the test attaches
// a second chromedp context to the engine-worker target (workers are listed by
// Target.getTargets with type "worker") and evaluates there.
package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/chromedp/chromedp"

	"rvim/server"
)

// perfEntry is the worker-side mark/measure projection the test evaluates out.
type perfEntry struct {
	Type   string `json:"t"` // "mark" | "measure"
	Name   string `json:"n"`
	Detail *struct {
		Devtools *struct {
			DataType   string     `json:"dataType"`
			Track      string     `json:"track"`
			TrackGroup string     `json:"trackGroup"`
			Color      string     `json:"color"`
			Properties [][]string `json:"properties"`
		} `json:"devtools"`
	} `json:"d"`
}

func (e perfEntry) prop(key string) (string, bool) {
	if e.Detail == nil || e.Detail.Devtools == nil {
		return "", false
	}
	for _, kv := range e.Detail.Devtools.Properties {
		if len(kv) == 2 && kv[0] == key {
			return kv[1], true
		}
	}
	return "", false
}

func TestBrowserPerfTrack(t *testing.T) {
	bundle := bundleDir(t)
	if _, err := chromeFound(); err != nil {
		t.Skip("no Chrome/Chromium on PATH; skipping browser e2e")
	}

	root := t.TempDir()
	writeFile(t, filepath.Join(root, "preexisting.txt"), "perf track content\n")

	srv := server.New(server.Config{
		Root:        root,
		Port:        0,
		Assets:      server.NewAssetServer(os.DirFS(bundle)),
		ProxyConfig: true,
	}, server.NewRegistry())
	if err := srv.Listen(); err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve() }()
	defer srv.Close(context.Background())
	url := "http://" + srv.Addr() + "/"

	ctx, cancel := newChrome(t)
	defer cancel()
	ctx, cancelT := context.WithTimeout(ctx, 90*time.Second)
	defer cancelT()

	if err := chromedp.Run(ctx,
		chromedp.Navigate(url),
		chromedp.Poll(`!!window.nvim && /attached/.test(document.body.dataset.status||"")`,
			nil, chromedp.WithPollingTimeout(60*time.Second)),
		chromedp.Poll(`/proxy connected/.test(document.body.dataset.status||"")`,
			nil, chromedp.WithPollingTimeout(20*time.Second)),
	); err != nil {
		t.Fatalf("engine boot / proxy connect: %v", err)
	}

	// Trigger one of each instrumented shape through the REAL proxy:
	//   - a successful fs request/response pair  -> an "IO proxy" track measure;
	//   - a failing fs request (missing file)    -> a FAILED measure, color 'error';
	//   - a process spawn whose stdout is pushed -> a 'push proc.stdout' mark.
	if got := evalRPC(t, ctx, `window.nvim.request('nvim_eval', ['join(readfile("/host/preexisting.txt"), "\\n")'])`); !strings.Contains(got, "perf track content") {
		t.Fatalf("readfile returned %q", got)
	}
	// readfile() of a MISSING file: the engine's open syscall becomes an fs.open
	// request the server rejects (os.OpenFile ENOENT -> ok:false frame), driving
	// the instrumentation's rejection arm. The nvim-level E484/E485 is the whole
	// point — swallow it instead of evalRPC's fail-on-error.
	var ignored string
	if err := chromedp.Run(ctx, chromedp.Evaluate(
		`window.nvim.request('nvim_eval', ['readfile("/host/definitely-missing.txt")']).then(function(){return 'ok'}, function(){return 'expected-error'})`,
		&ignored, awaitPromise)); err != nil {
		t.Fatalf("readfile(missing): %v", err)
	}
	if got := evalRPC(t, ctx, `window.nvim.request('nvim_eval', ['system("echo perf-push-ok")'])`); !strings.Contains(got, "perf-push-ok") {
		t.Fatalf("system() returned %q", got)
	}

	// Attach a second devtools session to the engine worker and read its
	// User Timing buffer.
	wctx, wcancel := engineWorkerCtx(t, ctx)
	defer wcancel()

	// The measures are emitted in a .then on the request promise, so they can
	// trail the RPC responses by a microtask hop or two — poll briefly.
	var entries []perfEntry
	deadline := time.Now().Add(10 * time.Second)
	for {
		entries = workerPerfEntries(t, wctx)
		if findEntry(entries, "measure", "fs.read /preexisting.txt (") != nil &&
			findEntry(entries, "measure", "fs.open /definitely-missing.txt FAILED") != nil &&
			findEntry(entries, "mark", "push proc.stdout") != nil {
			break
		}
		if time.Now().After(deadline) {
			break // fall through; the subtests report what is missing
		}
		time.Sleep(200 * time.Millisecond)
	}

	t.Run("fs request/response is a custom-track measure", func(t *testing.T) {
		e := findEntry(entries, "measure", "fs.read /preexisting.txt (")
		if e == nil {
			t.Fatalf("no fs.read measure; entries:\n%s", dumpEntries(entries))
		}
		if !strings.Contains(e.Name, "preexisting.txt") {
			t.Errorf("fs.read measure name %q does not carry the target path", e.Name)
		}
		dt := e.Detail.Devtools // findEntry only matches entries with a devtools payload
		if dt.DataType != "track-entry" || dt.Track != "IO proxy" || dt.TrackGroup != "rvim" {
			t.Errorf("devtools payload = %+v, want dataType=track-entry track=%q trackGroup=rvim", dt, "IO proxy")
		}
		if dt.Color != "primary" {
			t.Errorf("fs measure color = %q, want primary", dt.Color)
		}
		if m, ok := e.prop("method"); !ok || m != "fs.read" {
			t.Errorf("method property = %q (present %v), want fs.read", m, ok)
		}
		if n, ok := e.prop("received bytes"); !ok || n == "0" {
			t.Errorf("received bytes property = %q (present %v), want the read size", n, ok)
		}
	})

	t.Run("failed request is a red FAILED measure with the error", func(t *testing.T) {
		e := findEntry(entries, "measure", "fs.open /definitely-missing.txt FAILED")
		if e == nil {
			t.Fatalf("no FAILED fs.open measure; entries:\n%s", dumpEntries(entries))
		}
		if e.Detail.Devtools.Color != "error" {
			t.Errorf("failed measure color = %q, want error", e.Detail.Devtools.Color)
		}
		if msg, ok := e.prop("error"); !ok || msg == "" {
			t.Errorf("error property = %q (present %v), want the failure message", msg, ok)
		}
	})

	t.Run("server push is a marker mark", func(t *testing.T) {
		e := findEntry(entries, "mark", "push proc.stdout")
		if e == nil {
			t.Fatalf("no 'push proc.stdout' mark; entries:\n%s", dumpEntries(entries))
		}
		if e.Detail.Devtools.DataType != "marker" {
			t.Errorf("push mark dataType = %q, want marker", e.Detail.Devtools.DataType)
		}
	})

	t.Run("connection status is a marker mark", func(t *testing.T) {
		e := findEntry(entries, "mark", "proxy connected")
		if e == nil {
			t.Fatalf("no 'proxy connected' mark; entries:\n%s", dumpEntries(entries))
		}
		if e.Detail.Devtools.DataType != "marker" {
			t.Errorf("status mark dataType = %q, want marker", e.Detail.Devtools.DataType)
		}
	})
}

// engineWorkerCtx attaches a chromedp context to the engine-worker dedicated
// worker target (type "worker", url ending in engine-worker.js).
func engineWorkerCtx(t *testing.T, ctx context.Context) (context.Context, context.CancelFunc) {
	t.Helper()
	infos, err := chromedp.Targets(ctx)
	if err != nil {
		t.Fatalf("listing targets: %v", err)
	}
	for _, ti := range infos {
		if ti.Type == "worker" && strings.Contains(ti.URL, "engine-worker") {
			return chromedp.NewContext(ctx, chromedp.WithTargetID(ti.TargetID))
		}
	}
	var got []string
	for _, ti := range infos {
		got = append(got, fmt.Sprintf("%s %s", ti.Type, ti.URL))
	}
	t.Fatalf("no engine-worker target; targets:\n%s", strings.Join(got, "\n"))
	return nil, nil // unreachable
}

// workerPerfEntries reads the worker's User Timing marks + measures, with each
// entry's detail (where the devtools track payload lives — entry.toJSON()
// omits it, so the projection is explicit).
func workerPerfEntries(t *testing.T, wctx context.Context) []perfEntry {
	t.Helper()
	var raw string
	if err := chromedp.Run(wctx, chromedp.Evaluate(
		`JSON.stringify(performance.getEntriesByType('measure').concat(performance.getEntriesByType('mark'))
		   .map(function (e) { return { t: e.entryType, n: e.name, d: e.detail || null }; }))`, &raw)); err != nil {
		t.Fatalf("evaluating in the engine worker: %v", err)
	}
	var entries []perfEntry
	if err := json.Unmarshal([]byte(raw), &entries); err != nil {
		t.Fatalf("parsing worker perf entries: %v\n%s", err, raw)
	}
	return entries
}

// findEntry returns the first instrumented entry (one carrying a devtools
// payload) of the given type whose name starts with prefix.
func findEntry(entries []perfEntry, typ, prefix string) *perfEntry {
	for i := range entries {
		e := &entries[i]
		if e.Type == typ && strings.HasPrefix(e.Name, prefix) &&
			e.Detail != nil && e.Detail.Devtools != nil {
			return e
		}
	}
	return nil
}

func dumpEntries(entries []perfEntry) string {
	var b strings.Builder
	for _, e := range entries {
		fmt.Fprintf(&b, "  %s %q\n", e.Type, e.Name)
	}
	if b.Len() == 0 {
		return "  (none)"
	}
	return b.String()
}
