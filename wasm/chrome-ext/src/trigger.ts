// wasm/chrome-ext/src/trigger.ts - the always-injected content script.
//
// Kept deliberately tiny (every page loads it): it only listens for the
// activation keybinding on a focused <textarea> and asks the service worker to
// inject the real overlay stack (background.ts -> chrome.scripting). Repeat
// activations in a frame that already has the stack call the overlay directly
// (with a fire-and-forget 'nvim-ensure' so the engine host exists even if the
// browser reclaimed it).
//
// Keybinding: Ctrl+Shift+. ("Period" by KeyboardEvent.code, so it's layout-
// independent and unaffected by what character Shift produces).
'use strict';

(function () {
  const w = window as any;
  if (w.__nvimTriggerInstalled) { return; }
  w.__nvimTriggerInstalled = true;

  function eligible(el: any): boolean {
    return el instanceof HTMLTextAreaElement && !el.disabled;
  }

  window.addEventListener('keydown', function (e: KeyboardEvent) {
    if (!(e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'Period')) { return; }
    // composedPath() sees through shadow DOM (the plain target is retargeted
    // to the shadow host); fall back to the target / active element.
    const path = typeof e.composedPath === 'function' ? e.composedPath() : null;
    const el: any = (path && path[0]) || e.target || document.activeElement;
    if (!eligible(el)) { return; }
    e.preventDefault();
    e.stopImmediatePropagation();

    if (w.__nvimOverlay) {
      // Stack already injected here: open directly, but ping the worker so the
      // offscreen engine host is (re)created if the browser reclaimed it.
      try { chrome.runtime.sendMessage({ type: 'nvim-ensure' }, function () { void chrome.runtime.lastError; }); }
      catch (_e) { /* extension reloaded under us; the open below still works if the host lives */ }
      w.__nvimOverlay.open(el);
      return;
    }

    w.__nvimPendingTarget = el;
    try {
      chrome.runtime.sendMessage({ type: 'nvim-activate' }, function (resp: any) {
        void chrome.runtime.lastError;
        if (!resp || !resp.ok) {
          console.warn('[nvim-textarea] activation failed:', resp && resp.error || chrome.runtime.lastError);
        }
      });
    } catch (err) {
      // "Extension context invalidated": the extension was reloaded and this
      // orphaned script can't reach it anymore. A page reload re-injects.
      console.warn('[nvim-textarea] cannot reach extension (reload the page?):', err);
    }
  }, true);   // capture: run before the page's bubble-phase hotkey handlers
})();
