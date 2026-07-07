// wasm/chrome-ext/src/background.ts - the MV3 service worker.
//
// Deliberately tiny: MV3 service workers are EPHEMERAL (killed after ~30s
// idle) and cannot spawn Web Workers, so nothing long-lived can run here. Its
// two jobs:
//
//   1. Ensure the OFFSCREEN DOCUMENT exists (offscreen.html) -- the persistent
//      extension context that hosts the Neovim engine Web Workers and keeps a
//      pre-warmed engine ready (see offscreen.ts).
//   2. On a content-script activation request, inject the overlay stack
//      (msgpack + grid-renderer + neovim core/UI + overlay glue) into the
//      requesting frame via chrome.scripting. The heavy libraries are injected
//      ON DEMAND so every page load only pays for the ~1KB trigger script.
'use strict';

const OFFSCREEN_URL = 'offscreen.html';

// The overlay stack, in load order (each UMD sets a global the next one reads;
// overlay.js self-opens on the pending target recorded by trigger.js).
const OVERLAY_FILES = [
  'msgpack.min.js',      // globalThis.MessagePack
  'grid-renderer.js',    // globalThis.GridRenderer
  'neovim.js',           // globalThis.Neovim (msgpack-RPC core)
  'neovim-ui.js',        // globalThis.NeovimUI (Screen + canvas mount)
  'ext-common.js',       // globalThis.NvimExt (port protocol helpers)
  'overlay.js',          // session glue; defines window.__nvimOverlay + opens
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

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || (msg.type !== 'nvim-activate' && msg.type !== 'nvim-ensure')) { return false; }
  (async function () {
    await ensureOffscreen();
    if (msg.type === 'nvim-activate' && sender.tab && sender.tab.id != null) {
      await chrome.scripting.executeScript({
        target: { tabId: sender.tab.id, frameIds: [sender.frameId || 0] },
        files: OVERLAY_FILES,
      });
    }
    sendResponse({ ok: true });
  })().catch(function (e: any) {
    sendResponse({ ok: false, error: String(e && e.message || e) });
  });
  return true;   // async sendResponse
});
