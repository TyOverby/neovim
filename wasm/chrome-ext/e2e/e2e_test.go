// Browser e2e for the chrome extension: real headless Chrome, the real
// unpacked extension (build-ext.sh output), a real page with a <textarea>.
//
// The extension is loaded via the CDP Extensions.loadUnpacked command
// (--enable-unsafe-extension-debugging): branded Google Chrome >= 137 dropped
// the --load-extension flag, so that command is the supported path (we still
// pass the flag for Chromium builds, where it is honored first).
//
// The test drives the whole user flow with synthesized trusted input events:
// focus the textarea -> Ctrl+Shift+. -> wait for the overlay canvas + the
// data-nvim-ready marker -> edit with normal-mode keys -> `:w` pushes the
// buffer into the textarea (input events observed by the page) -> `:wq`
// pushes and tears the overlay down, restoring focus. A second session
// exercises the pre-warmed engine and plain `:q` on a modified buffer
// (discard: no nag, no write-back); a third does linewise yank/put through
// the real system clipboard.
//
// Skips (not fails) without Chrome or a built _ext. Run:
//
//	wasm/chrome-ext/build-ext.sh && cd wasm/chrome-ext/e2e && go test -v
package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/chromedp/cdproto/browser"
	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/extensions"
	"github.com/chromedp/cdproto/input"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/chromedp"
)

const pageHTML = `<!doctype html>
<meta charset="utf-8">
<title>textarea host</title>
<body>
  <h1>test page</h1>
  <textarea id="ta" style="width:420px;height:180px;color:#204060;background:#f5f0e8;padding:6px;border:3px solid #888;border-radius:5px;font-family:monospace;font-size:15px">hello from the page</textarea>
  <script>
    // Count the framework-visible write-backs (overlay dispatches input events
    // through the native value setter).
    window.inputEvents = 0;
    document.getElementById('ta').addEventListener('input', function () { window.inputEvents++; });
  </script>
</body>`

func chromeFound() (string, error) {
	for _, b := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser"} {
		if p, err := exec.LookPath(b); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("no chrome")
}

// extDir returns the unpacked extension: NVIM_EXT_DIR if set, else the
// default build-ext.sh output (wasm/chrome-ext/_ext). Skips if absent.
func extDir(t *testing.T) string {
	if d := os.Getenv("NVIM_EXT_DIR"); d != "" {
		if _, err := os.Stat(filepath.Join(d, "manifest.json")); err != nil {
			t.Skipf("NVIM_EXT_DIR=%s has no manifest.json: %v", d, err)
		}
		return d
	}
	_, thisFile, _, _ := runtime.Caller(0)
	d := filepath.Join(filepath.Dir(thisFile), "..", "_ext")
	if _, err := os.Stat(filepath.Join(d, "manifest.json")); err != nil {
		t.Skip("no built extension (run wasm/chrome-ext/build-ext.sh, or set NVIM_EXT_DIR)")
	}
	abs, err := filepath.Abs(d)
	if err != nil {
		t.Fatal(err)
	}
	return abs
}

// newChromeWithExt launches headless Chrome and loads the unpacked extension.
func newChromeWithExt(t *testing.T, ext string) (context.Context, context.CancelFunc) {
	t.Helper()
	// NOT DefaultExecAllocatorOptions: that set includes --disable-extensions.
	opts := []chromedp.ExecAllocatorOption{
		chromedp.NoFirstRun,
		chromedp.NoDefaultBrowserCheck,
		chromedp.NoSandbox,
		chromedp.DisableGPU,
		chromedp.Headless,
		chromedp.Flag("disable-dev-shm-usage", true),
		// The supported unpacked-load path on Chrome >= 137:
		chromedp.Flag("enable-unsafe-extension-debugging", true),
		// Honored by Chromium builds (ignored by branded Chrome >= 137); the
		// CDP loadUnpacked below is idempotent enough that both paths coexist.
		chromedp.Flag("load-extension", ext),
	}
	allocCtx, cancelA := chromedp.NewExecAllocator(context.Background(), opts...)
	ctx, cancelC := chromedp.NewContext(allocCtx)
	cancel := func() { cancelC(); cancelA() }

	// Allocate the browser, then issue browser-domain commands.
	if err := chromedp.Run(ctx); err != nil {
		cancel()
		t.Fatalf("launching chrome: %v", err)
	}
	c := chromedp.FromContext(ctx)
	bctx := cdp.WithExecutor(ctx, c.Browser)
	if _, err := extensions.LoadUnpacked(ext).Do(bctx); err != nil {
		// Chromium may have already honored --load-extension; the first wait
		// on the overlay decides. Surface the error for diagnosis either way.
		t.Logf("Extensions.loadUnpacked: %v (may be fine if --load-extension was honored)", err)
	}
	return ctx, cancel
}

// key sends a trusted keydown+keyup pair. `key` is the KeyboardEvent.key the
// content scripts read; `code` matters only for the trigger chord.
func key(ctx context.Context, k, code string, mods input.Modifier) error {
	down := input.DispatchKeyEvent(input.KeyDown).WithKey(k).WithCode(code).WithModifiers(mods)
	up := input.DispatchKeyEvent(input.KeyUp).WithKey(k).WithCode(code).WithModifiers(mods)
	if err := chromedp.Run(ctx, down); err != nil {
		return err
	}
	return chromedp.Run(ctx, up)
}

// typeKeys sends a string one rune at a time (plain keydowns; the overlay's
// keydown handler feeds nvim_input from KeyboardEvent.key).
func typeKeys(t *testing.T, ctx context.Context, s string) {
	t.Helper()
	for _, r := range s {
		if err := key(ctx, string(r), "", 0); err != nil {
			t.Fatalf("typing %q: %v", r, err)
		}
	}
}

func enter(t *testing.T, ctx context.Context) {
	t.Helper()
	if err := key(ctx, "Enter", "Enter", 0); err != nil {
		t.Fatal(err)
	}
}

func escape(t *testing.T, ctx context.Context) {
	t.Helper()
	if err := key(ctx, "Escape", "Escape", 0); err != nil {
		t.Fatal(err)
	}
}

// trigger sends the activation chord Ctrl+Shift+. (the trigger matches on
// KeyboardEvent.code == "Period").
func trigger(t *testing.T, ctx context.Context) {
	t.Helper()
	if err := key(ctx, ">", "Period", input.ModifierCtrl|input.ModifierShift); err != nil {
		t.Fatal(err)
	}
}

// waitFor polls a boolean page expression.
func waitFor(t *testing.T, ctx context.Context, expr, what string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		var ok bool
		if err := chromedp.Run(ctx, chromedp.Evaluate(expr, &ok)); err != nil {
			t.Fatalf("evaluating %s: %v", expr, err)
		}
		if ok {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s (%s)", what, expr)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func evalString(t *testing.T, ctx context.Context, expr string) string {
	t.Helper()
	var s string
	if err := chromedp.Run(ctx, chromedp.Evaluate(expr, &s)); err != nil {
		t.Fatalf("evaluating %s: %v", expr, err)
	}
	return s
}

func evalFloat(t *testing.T, ctx context.Context, expr string) float64 {
	t.Helper()
	var f float64
	if err := chromedp.Run(ctx, chromedp.Evaluate(expr, &f)); err != nil {
		t.Fatalf("evaluating %s: %v", expr, err)
	}
	return f
}

// drag presses the left button at (x0,y0), moves in steps, and releases at
// (x1,y1) -- real trusted input, exactly what engages a CSS resize handle.
func drag(t *testing.T, ctx context.Context, x0, y0, x1, y1 float64) {
	t.Helper()
	press := input.DispatchMouseEvent(input.MousePressed, x0, y0).
		WithButton(input.Left).WithButtons(1).WithClickCount(1)
	if err := chromedp.Run(ctx, press); err != nil {
		t.Fatalf("mouse press: %v", err)
	}
	const steps = 8
	for i := 1; i <= steps; i++ {
		f := float64(i) / steps
		move := input.DispatchMouseEvent(input.MouseMoved, x0+(x1-x0)*f, y0+(y1-y0)*f).
			WithButton(input.Left).WithButtons(1)
		if err := chromedp.Run(ctx, move); err != nil {
			t.Fatalf("mouse move: %v", err)
		}
	}
	release := input.DispatchMouseEvent(input.MouseReleased, x1, y1).
		WithButton(input.Left).WithClickCount(1)
	if err := chromedp.Run(ctx, release); err != nil {
		t.Fatalf("mouse release: %v", err)
	}
}

func TestTextareaRoundTrip(t *testing.T) {
	if _, err := chromeFound(); err != nil {
		t.Skip("no Chrome/Chromium on PATH; skipping browser e2e")
	}
	ext := extDir(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, pageHTML)
	}))
	defer srv.Close()

	ctx, cancel := newChromeWithExt(t, ext)
	defer cancel()
	ctx, cancelT := context.WithTimeout(ctx, 180*time.Second)
	defer cancelT()

	// The linewise yank/put session below round-trips the real system
	// clipboard (clipboard=unnamedplus routes y/p through navigator.clipboard);
	// headless has no permission prompt, so grant it up front.
	bctx := cdp.WithExecutor(ctx, chromedp.FromContext(ctx).Browser)
	if err := browser.GrantPermissions([]browser.PermissionType{
		browser.PermissionTypeClipboardReadWrite,
		browser.PermissionTypeClipboardSanitizedWrite,
	}).WithOrigin(srv.URL).Do(bctx); err != nil {
		t.Fatalf("granting clipboard permission: %v", err)
	}

	if err := chromedp.Run(ctx,
		chromedp.Navigate(srv.URL),
		chromedp.WaitVisible("#ta", chromedp.ByID),
		// Make the tab VISIBLE: chromedp's target starts hidden in headless,
		// and Chrome parks rendering frames for hidden pages -- ResizeObserver
		// callbacks (the resize-propagation seam) and rAF paints starve until
		// the page is visible.
		chromedp.ActionFunc(func(ctx context.Context) error { return page.BringToFront().Do(ctx) }),
		chromedp.Focus("#ta", chromedp.ByID),
	); err != nil {
		t.Fatal(err)
	}
	// Give the document_idle content script a beat to install its listener.
	waitFor(t, ctx, `document.activeElement && document.activeElement.id === 'ta'`, "textarea focused", 5*time.Second)
	time.Sleep(300 * time.Millisecond)

	// ---- session 1: edit, :w (live write-back), :wq (write + close) --------
	// First-paint probe: sample a cell-region pixel (bottom-left, always
	// empty buffer background before we type) every frame from before the
	// overlay exists, recording each distinct opaque color. If any unthemed
	// frame reaches the canvas (the "black flash": nvim's default dark
	// colorscheme painting before the theme lands), a dark sample shows up.
	// It also flags the "white flash": any frame where the box is visible
	// (opacity > 0) while the canvas has no pixels yet.
	evalString(t, ctx, `(() => {
		window.paintSamples = [];
		window.sawVisibleEmpty = false;
		(function poll() {
			const box = document.querySelector('[data-nvim-overlay]');
			if (box) {
				let painted = false;
				const c = box.querySelector('canvas');
				if (c) {
					try {
						const d = c.getContext('2d').getImageData(8, c.height - 8, 1, 1).data;
						if (d[3] > 0) {
							painted = true;
							const key = d[0] + ',' + d[1] + ',' + d[2];
							if (window.paintSamples.indexOf(key) < 0) window.paintSamples.push(key);
						}
					} catch (e) {}
				}
				if (!painted && getComputedStyle(box).opacity !== '0') window.sawVisibleEmpty = true;
			}
			if (!window.paintStop) requestAnimationFrame(poll);
		})();
		return 'ok';
	})()`)
	trigger(t, ctx)
	waitFor(t, ctx, `!!document.querySelector('[data-nvim-overlay]')`, "overlay to appear", 20*time.Second)
	waitFor(t, ctx, `!!document.querySelector('[data-nvim-ready]')`, "session ready (engine attached, buffer loaded)", 60*time.Second)
	waitFor(t, ctx, `getComputedStyle(document.querySelector('[data-nvim-overlay]')).opacity === '1'`,
		"overlay revealed after the first painted frame", 10*time.Second)
	// The probe watched every frame since before the trigger: the box must
	// never have been visible while the canvas was still empty (the "white
	// flash" -- a bare theme-colored rectangle covering the textarea).
	if evalString(t, ctx, `String(window.sawVisibleEmpty)`) != "false" {
		t.Fatal("overlay was visible before the canvas had content (white flash)")
	}

	// ---- theme contract: overlay replicates the textarea's colors ----------
	// The empty right margin must be the textarea's background (#f5f0e8, a
	// LIGHT background -- also exercises the 'background' option flip), and
	// the first text row must contain pixels near the textarea's text color
	// (#204060; antialiasing means near, not exact).
	waitFor(t, ctx, `(() => {
		const c = document.querySelector('[data-nvim-overlay] canvas');
		const g = c.getContext('2d');
		const m = g.getImageData(c.width - 4, 4, 1, 1).data;
		if (!(m[0] === 0xf5 && m[1] === 0xf0 && m[2] === 0xe8)) return false;
		const row = g.getImageData(0, 0, 160, 18).data;
		for (let i = 0; i < row.length; i += 4) {
			const d = Math.abs(row[i] - 0x20) + Math.abs(row[i+1] - 0x40) + Math.abs(row[i+2] - 0x60);
			if (d < 60) return true;
		}
		return false;
	})()`, "overlay themed with the textarea's colors", 10*time.Second)

	// Every color the probe saw must be light (the theme bg #f5f0e8 sums to
	// 725; nvim's unthemed dark default #14161b sums to 75).
	samples := evalString(t, ctx, `(() => { window.paintStop = true; return JSON.stringify(window.paintSamples); })()`)
	var seen []string
	if err := json.Unmarshal([]byte(samples), &seen); err != nil {
		t.Fatalf("parsing paint samples %q: %v", samples, err)
	}
	if len(seen) == 0 {
		t.Fatal("first-paint probe saw no painted pixels (probe broken?)")
	}
	for _, s := range seen {
		var r, g, b int
		if _, err := fmt.Sscanf(s, "%d,%d,%d", &r, &g, &b); err != nil {
			t.Fatalf("bad paint sample %q", s)
		}
		if r+g+b < 300 {
			t.Fatalf("unthemed dark frame reached the canvas before the theme (sample rgb(%s), all: %v)", s, seen)
		}
	}

	// ---- size contract: overlay == textarea, resize propagates back --------
	waitFor(t, ctx, `(() => {
		const ta = document.getElementById('ta').getBoundingClientRect();
		const r = document.querySelector('[data-nvim-overlay]').getBoundingClientRect();
		return ta.width > 400 && Math.abs(r.width - ta.width) < 2 && Math.abs(r.height - ta.height) < 2;
	})()`, "overlay sized to the textarea", 5*time.Second)
	// Box styling replicated: padding/border/radius copied, no drop shadow;
	// the canvas fills the CONTENT box (textarea rect minus 2x(6px padding +
	// 3px border) = -18), so the grid is inset like the textarea's text.
	waitFor(t, ctx, `(() => {
		const cs = getComputedStyle(document.querySelector('[data-nvim-overlay]'));
		const cv = document.querySelector('[data-nvim-overlay] canvas').getBoundingClientRect();
		const ta = document.getElementById('ta').getBoundingClientRect();
		return cs.paddingTop === '6px' && cs.borderTopWidth === '3px' &&
			cs.borderTopLeftRadius === '5px' && cs.boxShadow === 'none' &&
			Math.abs(cv.width - (ta.width - 18)) < 2 && Math.abs(cv.height - (ta.height - 18)) < 2;
	})()`, "textarea box styles replicated (padding/border/radius, no shadow)", 5*time.Second)
	waitFor(t, ctx, `getComputedStyle(document.querySelector('[data-nvim-overlay]')).resize === 'both'`,
		"overlay resizable like the textarea (resize:both on the box; a <canvas> can't carry resize)", 5*time.Second)
	// REALLY drag the native resize handle (grab the box's bottom-right
	// corner with trusted mouse events, drag +140/+140) and expect the
	// textarea to follow. This is the regression a style-set simulation
	// missed: `resize` on the <canvas> never grew a handle at all.
	taW := evalFloat(t, ctx, `document.getElementById('ta').getBoundingClientRect().width`)
	taH := evalFloat(t, ctx, `document.getElementById('ta').getBoundingClientRect().height`)
	cornerX := evalFloat(t, ctx, `document.querySelector('[data-nvim-overlay]').getBoundingClientRect().right`) - 5
	cornerY := evalFloat(t, ctx, `document.querySelector('[data-nvim-overlay]').getBoundingClientRect().bottom`) - 5
	drag(t, ctx, cornerX, cornerY, cornerX+140, cornerY+140)
	waitFor(t, ctx, fmt.Sprintf(`(() => {
		const r = document.getElementById('ta').getBoundingClientRect();
		return Math.abs(r.width - %f) < 4 && Math.abs(r.height - %f) < 4;
	})()`, taW+140, taH+140), "textarea to follow the native-handle drag (+140,+140)", 5*time.Second)

	// Replace the buffer: ggdG then insert; Esc; :w -> textarea updates, overlay stays.
	typeKeys(t, ctx, "ggdG")
	typeKeys(t, ctx, "ihello from nvim")
	escape(t, ctx)
	typeKeys(t, ctx, ":w")
	enter(t, ctx)
	waitFor(t, ctx, `document.getElementById('ta').value === 'hello from nvim'`, ":w write-back", 15*time.Second)
	waitFor(t, ctx, `window.inputEvents > 0`, "input event dispatched on write-back", 5*time.Second)
	var overlayGone bool
	if err := chromedp.Run(ctx, chromedp.Evaluate(`!document.querySelector('[data-nvim-overlay]')`, &overlayGone)); err != nil {
		t.Fatal(err)
	}
	if overlayGone {
		t.Fatal("overlay disappeared after :w (should only close on quit)")
	}

	// Append and :wq -> final content lands, overlay tears down, focus returns.
	typeKeys(t, ctx, "A!")
	escape(t, ctx)
	typeKeys(t, ctx, ":wq")
	enter(t, ctx)
	waitFor(t, ctx, `!document.querySelector('[data-nvim-overlay]')`, "overlay to close on :wq", 15*time.Second)
	if got := evalString(t, ctx, `document.getElementById('ta').value`); got != "hello from nvim!" {
		t.Fatalf("textarea after :wq = %q, want %q", got, "hello from nvim!")
	}
	waitFor(t, ctx, `document.activeElement && document.activeElement.id === 'ta'`, "focus restored to textarea", 5*time.Second)

	// ---- session 2: pre-warmed engine; plain :q on a MODIFIED buffer -------
	// discards: no E37 nag (QuitPre clears 'modified'), no write-back.
	start := time.Now()
	trigger(t, ctx)
	waitFor(t, ctx, `!!document.querySelector('[data-nvim-ready]')`, "second session ready (pre-warmed engine)", 60*time.Second)
	t.Logf("second session ready in %s (pre-warmed engine)", time.Since(start))
	typeKeys(t, ctx, "ggdG")
	typeKeys(t, ctx, "ithrown away")
	escape(t, ctx)
	typeKeys(t, ctx, ":q")
	enter(t, ctx)
	waitFor(t, ctx, `!document.querySelector('[data-nvim-overlay]')`, "overlay to close on :q despite unsaved changes", 15*time.Second)
	if got := evalString(t, ctx, `document.getElementById('ta').value`); got != "hello from nvim!" {
		t.Fatalf("textarea after :q = %q, want unchanged %q", got, "hello from nvim!")
	}
	if strings.Contains(evalString(t, ctx, `document.getElementById('ta').value`), "thrown away") {
		t.Fatal(":q leaked unwritten buffer content into the textarea")
	}

	// ---- session 3: LINEWISE yank/put through the system clipboard ---------
	// `yy` then `p` must open a NEW line (regtype 'V' recovered by the
	// library's browser clipboard provider), not paste inline -- the
	// historical regtype regression this guards against.
	trigger(t, ctx)
	waitFor(t, ctx, `!!document.querySelector('[data-nvim-ready]')`, "third session ready", 60*time.Second)
	typeKeys(t, ctx, "yyp")
	escape(t, ctx)
	typeKeys(t, ctx, ":wq")
	enter(t, ctx)
	waitFor(t, ctx, `!document.querySelector('[data-nvim-overlay]')`, "overlay to close after yyp :wq", 15*time.Second)
	if got := evalString(t, ctx, `document.getElementById('ta').value`); got != "hello from nvim!\nhello from nvim!" {
		t.Fatalf("textarea after yyp = %q, want two lines (linewise put)", got)
	}
}
