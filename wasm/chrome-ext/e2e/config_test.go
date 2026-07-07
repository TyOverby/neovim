// Config-persistence e2e: edits to ~/.config/nvim survive across engine
// instances (each session is a fresh engine seeded from the extension's
// IndexedDB store), and deleting init.vim regenerates the defaults.
//
// The observable used throughout: a `nnoremap Q :q!<CR>` mapping added to
// init.vim. In a later session, pressing Q closes the overlay iff the config
// persisted (unmapped Q is a harmless no-op).
package e2e

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/chromedp"
)

func TestConfigPersistence(t *testing.T) {
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

	if err := chromedp.Run(ctx,
		chromedp.Navigate(srv.URL),
		chromedp.WaitVisible("#ta", chromedp.ByID),
		chromedp.ActionFunc(func(ctx context.Context) error { return page.BringToFront().Do(ctx) }),
		chromedp.Focus("#ta", chromedp.ByID),
	); err != nil {
		t.Fatal(err)
	}
	waitFor(t, ctx, `document.activeElement && document.activeElement.id === 'ta'`, "textarea focused", 5*time.Second)
	time.Sleep(300 * time.Millisecond)

	openSession := func(what string) {
		trigger(t, ctx)
		waitFor(t, ctx, `!!document.querySelector('[data-nvim-ready]')`, what+" session ready", 60*time.Second)
	}
	waitClosed := func(what string) {
		waitFor(t, ctx, `!document.querySelector('[data-nvim-overlay]')`, "overlay to close ("+what+")", 15*time.Second)
	}

	// ---- session 1: append a Q->:q! mapping to init.vim and :wq it ----------
	openSession("first")
	typeKeys(t, ctx, ":e $MYVIMRC")
	enter(t, ctx)
	time.Sleep(500 * time.Millisecond) // buffer switch
	typeKeys(t, ctx, "Go")             // open a line at EOF (insert mode)
	typeKeys(t, ctx, "nnoremap Q :q!<CR>")
	escape(t, ctx)
	typeKeys(t, ctx, ":wq") // writes init.vim (persisted via the FS hooks), exits
	enter(t, ctx)
	waitClosed(":wq of init.vim")

	// ---- session 2: fresh engine; the mapping must have persisted ----------
	openSession("second")
	typeKeys(t, ctx, "Q")
	waitClosed("Q mapping from persisted init.vim")
	if got := evalString(t, ctx, `document.getElementById('ta').value`); got != "hello from the page" {
		t.Fatalf("textarea changed by config sessions: %q", got)
	}

	// ---- session 3: delete init.vim ----------------------------------------
	openSession("third")
	typeKeys(t, ctx, ":call delete($MYVIMRC)")
	enter(t, ctx)
	typeKeys(t, ctx, ":q")
	enter(t, ctx)
	waitClosed("session that deleted init.vim")

	// ---- session 4: defaults regenerated -- Q is a no-op again -------------
	openSession("fourth")
	typeKeys(t, ctx, "Q")
	time.Sleep(700 * time.Millisecond)
	var stillOpen bool
	if err := chromedp.Run(ctx, chromedp.Evaluate(`!!document.querySelector('[data-nvim-overlay]')`, &stillOpen)); err != nil {
		t.Fatal(err)
	}
	if !stillOpen {
		t.Fatal("Q still quits after init.vim was deleted (defaults not regenerated)")
	}
	// The regenerated default config is active in this same session (Q did
	// nothing above; :q from the default setup closes cleanly).
	typeKeys(t, ctx, ":q")
	enter(t, ctx)
	waitClosed("final :q")
}

// Persistence across a full BROWSER restart: the config store is the
// extension origin's IndexedDB inside the profile, and an unpacked
// extension's ID derives from its path, so relaunching Chrome with the same
// user-data-dir + extension path lands on the same store.
func TestConfigPersistsAcrossRestart(t *testing.T) {
	if _, err := chromeFound(); err != nil {
		t.Skip("no Chrome/Chromium on PATH; skipping browser e2e")
	}
	ext := extDir(t)
	// NOT t.TempDir(): its strict RemoveAll cleanup races Chrome's async
	// shutdown (the browser still holds profile files moments after the
	// context is cancelled). Best-effort cleanup after a grace period.
	profile, err := os.MkdirTemp("", "nvim-ext-profile-")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		time.Sleep(1 * time.Second)
		_ = os.RemoveAll(profile)
	}()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, pageHTML)
	}))
	defer srv.Close()

	launch := func() (context.Context, context.CancelFunc) {
		ctx, cancel := newChromeWithExtProfile(t, ext, profile)
		tctx, cancelT := context.WithTimeout(ctx, 120*time.Second)
		if err := chromedp.Run(tctx,
			chromedp.Navigate(srv.URL),
			chromedp.WaitVisible("#ta", chromedp.ByID),
			chromedp.ActionFunc(func(ctx context.Context) error { return page.BringToFront().Do(ctx) }),
			chromedp.Focus("#ta", chromedp.ByID),
		); err != nil {
			t.Fatal(err)
		}
		time.Sleep(300 * time.Millisecond)
		return tctx, func() { cancelT(); cancel() }
	}

	// Launch 1: persist a Q -> :q! mapping.
	ctx, done := launch()
	trigger(t, ctx)
	waitFor(t, ctx, `!!document.querySelector('[data-nvim-ready]')`, "session ready (launch 1)", 60*time.Second)
	typeKeys(t, ctx, ":e $MYVIMRC")
	enter(t, ctx)
	time.Sleep(500 * time.Millisecond)
	typeKeys(t, ctx, "Go")
	typeKeys(t, ctx, "nnoremap Q :q!<CR>")
	escape(t, ctx)
	typeKeys(t, ctx, ":wq")
	enter(t, ctx)
	waitFor(t, ctx, `!document.querySelector('[data-nvim-overlay]')`, "overlay to close (launch 1)", 15*time.Second)
	time.Sleep(500 * time.Millisecond) // let the IDB write settle before killing the browser
	done()

	// Launch 2, same profile: the mapping must still be there.
	ctx, done = launch()
	defer done()
	trigger(t, ctx)
	waitFor(t, ctx, `!!document.querySelector('[data-nvim-ready]')`, "session ready (launch 2)", 60*time.Second)
	typeKeys(t, ctx, "Q")
	waitFor(t, ctx, `!document.querySelector('[data-nvim-overlay]')`, "Q mapping to survive the browser restart", 15*time.Second)
}
