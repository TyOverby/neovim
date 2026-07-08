// wasm/chrome-ext/src/background.ts - the MV3 service worker.
//
// Deliberately tiny: MV3 service workers are EPHEMERAL (killed after ~30s
// idle) and cannot spawn Web Workers, so nothing long-lived can run here. Its
// two jobs:
//
//   1. Ensure the OFFSCREEN DOCUMENT exists (offscreen.html) -- the persistent
//      extension context that hosts the Neovim engine Web Workers and keeps a
//      pre-warmed engine ready (see offscreen.ts).
//   2. On activation, find the frame with the focused textarea, inject the
//      overlay stack (msgpack + grid-renderer + neovim core/UI + overlay
//      glue) into it via chrome.scripting, and open the overlay.
//
// PERMISSIONS MODEL: activeTab only -- no host permissions, no content
// scripts on pages. Activation is the chrome.commands keyboard shortcut
// (default Ctrl+Shift+., user-configurable at chrome://extensions/shortcuts)
// or the toolbar action; both are activeTab-granting user gestures, so the
// extension can touch a tab ONLY when invoked on it. The e2e (which cannot
// press browser-level shortcuts with synthesized input) loads a
// manifest-patched copy that adds a content-script trigger sending the
// 'nvim-activate' message -- same activate() path from there on.
'use strict';

const OFFSCREEN_URL = 'offscreen.html';

// The overlay stack, in load order (each UMD sets a global the next one reads).
const OVERLAY_FILES = [
  'msgpack.min.js',      // globalThis.MessagePack
  'grid-renderer.js',    // globalThis.GridRenderer
  'neovim.js',           // globalThis.Neovim (msgpack-RPC core)
  'neovim-ui.js',        // globalThis.NeovimUI (Screen + canvas mount)
  'ext-common.js',       // globalThis.NvimExt (port protocol helpers)
  'overlay.js',          // session glue; defines window.__nvimOverlay
];

// Create the offscreen document if it doesn't exist. Latched so concurrent
// activations don't race createDocument ("Only a single offscreen document
// may be created" is otherwise a real race).
let creating: Promise<void> | null = null;
async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) { return; }
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WORKERS'],
        justification: 'Hosts the long-lived Neovim WebAssembly engine workers',
      })
      .catch(function (e: any) {
        // Lost a create race with another event handler: fine as long as the
        // document exists now.
        console.warn('[nvim-textarea] createDocument:', e && e.message || e);
      })
      .then(function () { creating = null; });
  }
  await creating;
}

// Warm the engine host early so the first trigger hits a booted engine.
chrome.runtime.onInstalled.addListener(function () { ensureOffscreen(); });
chrome.runtime.onStartup.addListener(function () { ensureOffscreen(); });

// Runs in the page (isolated world) to locate the focused textarea's frame:
// with allFrames, only the frame that actually holds the focused element
// reports focused=true (a parent frame's activeElement is the <iframe>).
// `loaded` lets activate() skip re-injecting the stack. DOM globals go
// through globalThis: this file compiles under the WebWorker lib (it's a
// service worker), but these two functions are serialized by
// chrome.scripting and run in the page.
function probeFrame(): { eligible: boolean; focused: boolean; loaded: boolean } {
  const g: any = globalThis;
  const el: any = g.document.activeElement;
  const eligible = !!(el && el.tagName === 'TEXTAREA' && !el.disabled);
  return {
    eligible: eligible,
    focused: eligible && g.document.hasFocus(),
    loaded: !!g.__nvimOverlay,
  };
}

function openActive(): void {
  const o = (globalThis as any).__nvimOverlay;
  if (o) { o.openActive(); }
}

// The single activation path (keyboard command, toolbar action, or the test
// trigger's message): find the focused-textarea frame, inject, open.
async function activate(tabId: number): Promise<void> {
  await ensureOffscreen();
  const probes: any[] = await chrome.scripting.executeScript({
    target: { tabId: tabId, allFrames: true },
    func: probeFrame,
  });
  // Prefer the frame that HAS focus; fall back to any frame with an eligible
  // focused-element textarea (the toolbar action steals document focus).
  let frame = probes.find(function (r) { return r && r.result && r.result.focused; });
  if (!frame) {
    frame = probes.find(function (r) { return r && r.result && r.result.eligible; });
  }
  if (!frame) { return; }   // no focused textarea anywhere: nothing to do
  const target = { tabId: tabId, frameIds: [frame.frameId || 0] };
  if (!frame.result.loaded) {
    await chrome.scripting.executeScript({ target: target, files: OVERLAY_FILES });
  }
  await chrome.scripting.executeScript({ target: target, func: openActive });
}

function activateSafe(tabId: number, done?: (err?: any) => void): void {
  activate(tabId).then(
    function () { if (done) { done(); } },
    function (e: any) {
      console.warn('[nvim-textarea] activation failed:', e && e.message || e);
      if (done) { done(e); }
    }
  );
}

chrome.commands.onCommand.addListener(function (command, tab) {
  if (command !== 'nvim-activate' || !tab || tab.id == null) { return; }
  activateSafe(tab.id);
});

chrome.action.onClicked.addListener(function (tab) {
  if (!tab || tab.id == null) { return; }
  activateSafe(tab.id);
});

// The e2e's manifest-patched build adds a content-script trigger that sends
// this message (synthesized key events cannot fire browser-level commands).
// Inert in the production manifest: pages cannot message the extension, and
// no content scripts exist to do so.
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'nvim-activate' || !sender.tab || sender.tab.id == null) { return false; }
  activateSafe(sender.tab.id, function (err?: any) {
    sendResponse(err ? { ok: false, error: String(err && err.message || err) } : { ok: true });
  });
  return true;   // async sendResponse
});
