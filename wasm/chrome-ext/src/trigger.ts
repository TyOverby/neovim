// wasm/chrome-ext/src/trigger.ts - the in-page activation trigger.
//
// NOT part of the production manifest: production activation is the
// chrome.commands keyboard shortcut (+ toolbar action), which grants
// activeTab -- no content scripts, no host permissions. This script exists
// for the e2e, whose synthesized key events reach the renderer but not the
// browser's accelerator layer, so browser-level commands never fire: the
// test build patches the manifest to register this as a content script, and
// the keydown here sends the same activation message the command handler
// path uses (background.ts activate()).
//
// Keybinding: Ctrl+Shift+. ("Period" by KeyboardEvent.code, matching the
// production command's default).
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
