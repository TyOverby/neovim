// wasm/chrome-ext/src/offscreen.ts - the engine host, run in the extension's
// offscreen document (the only persistent MV3 context that can spawn Workers).
//
// Hosts the Neovim engine Web Workers (the stock wasm/web engine-worker.js,
// bundled unmodified) and bridges each editing session's chrome.runtime Port
// to its engine worker:
//
//   overlay (content script) <-- Port: {t:'rpc', b:<base64>} | {t:'status', s} -->
//   here <-- postMessage: ArrayBuffer (RPC bytes) | {kind:...} status --> engine
//
// WARM POOL: one engine is booted ahead of time. `:q`/`:wq` EXITS an --embed
// nvim (that is nvim's quit semantics), so a session consumes its engine; a
// replacement starts booting the moment one is claimed. The trigger keybinding
// therefore always finds a hot engine (the "long-lived worker" startup-time
// goal), and concurrent sessions -- several textareas, several tabs -- each
// get their own engine, which sidesteps sharing one msgpack-RPC channel
// (msgid collisions) and nvim's one-UI-per-channel limit.
'use strict';

const CFG: any = (globalThis as any).NVIM_EXT_CONFIG || {};

// The engine worker's init message (see wasm/web/src/engine-worker.ts): it
// prepends --embed to args; `plugins` picks the runtime variant baked into the
// bundle by build-ext.sh (ext-config.js).
const ENGINE_INIT = {
  args: ['-n'],
  plugins: CFG.plugins || 'core',
};

interface Engine {
  worker: Worker;
  dead: boolean;
  // Messages produced before a session claims this engine (boot statuses),
  // replayed on claim.
  pending: any[];
  deliver: ((m: any) => void) | null;
}

function spawnEngine(): Engine {
  const eng: Engine = {
    worker: new Worker('engine-worker.js'),
    dead: false,
    pending: [],
    deliver: null,
  };
  function emit(m: any): void {
    if (eng.deliver) { eng.deliver(m); } else { eng.pending.push(m); }
  }
  eng.worker.onmessage = function (e: MessageEvent) {
    const d = e.data;
    if (d instanceof ArrayBuffer) {
      emit({ t: 'rpc', b: NvimExt.b64FromBytes(new Uint8Array(d)) });
      return;
    }
    if (d && d.kind === 'exit') { eng.dead = true; }
    emit({ t: 'status', s: d });
  };
  eng.worker.onerror = function (e: any) {
    emit({ t: 'status', s: { kind: 'error', error: String(e && e.message || e) } });
  };
  eng.worker.postMessage(ENGINE_INIT);
  return eng;
}

// The pre-warmed engine. Booted at document load (background.js creates this
// document on install/startup), replaced on claim.
let warm: Engine | null = spawnEngine();

function claimEngine(): Engine {
  let eng = warm;
  warm = null;
  if (!eng || eng.dead) {
    // The warm engine crashed/exited while idle (or this raced): boot fresh.
    if (eng) { try { eng.worker.terminate(); } catch (_e) {} }
    eng = spawnEngine();
  }
  warm = spawnEngine();
  return eng;
}

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== NvimExt.PORT_NAME) { return; }
  const eng = claimEngine();
  eng.deliver = function (m) {
    try { port.postMessage(m); } catch (_e) { /* port gone; disconnect handler cleans up */ }
  };
  const backlog = eng.pending.splice(0);
  for (let i = 0; i < backlog.length; i++) { eng.deliver(backlog[i]); }

  port.onMessage.addListener(function (m) {
    if (!m || m.t !== 'rpc' || eng.dead) { return; }
    const u8 = NvimExt.bytesFromB64(m.b);
    eng.worker.postMessage(u8.buffer, [u8.buffer]);
  });
  port.onDisconnect.addListener(function () {
    // Session over (overlay closed, tab navigated/closed). The engine is
    // per-session; tear it down.
    eng.deliver = null;
    eng.dead = true;
    try { eng.worker.terminate(); } catch (_e) {}
  });
});
