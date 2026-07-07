// wasm/chrome-ext/src/offscreen.ts - the engine host, run in the extension's
// offscreen document (the only persistent MV3 context that can spawn Workers).
//
// Hosts the Neovim engine Web Workers (ext-engine-worker.js: the stock
// engine-worker.js wrapped with config-persistence FS hooks) and bridges each
// editing session's chrome.runtime Port to its engine:
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
//
// CONFIG PERSISTENCE: the user's ~/.config/nvim lives here, in the extension
// origin's IndexedDB (offscreen documents cannot use chrome.storage; IDB is
// persistent and shared with the rest of the extension). Every engine is
// SEEDED with the stored tree via the init message's `filesystem` (pre.js
// materializes it in MEMFS before main() -- that is the "read" side), and the
// worker's FS hooks report every write/delete under the config dir back here
// (the "write" side). A change discards the pre-warmed engine so the next
// session inherits it. init.vim is special: when the store has none (first
// run, or the user deleted it), the DEFAULT config below is seeded instead --
// deleting init.vim restores the defaults on the next session.
'use strict';

const CFG: any = (globalThis as any).NVIM_EXT_CONFIG || {};

const CONFIG_DIR = '/root/.config/nvim';

// The default ~/.config/nvim/init.vim, seeded whenever the store has no
// init.vim. Everything here is USER-OVERRIDABLE editor configuration (the
// session-specific glue -- buffer autocmds, textarea theme -- stays in
// overlay.ts). Keep in sync with README.md.
const DEFAULT_INIT_VIM = [
  '" nvim-textarea default configuration.',
  '" Edits persist across sessions (stored by the extension): :e $MYVIMRC',
  '" Deleting this file restores these defaults on the next session.',
  '',
  '" Navigate soft-wrapped lines by display line.',
  'nnoremap j gj',
  'nnoremap k gk',
  'vnoremap j gj',
  'vnoremap k gk',
  'nnoremap <Up> gk',
  'nnoremap <Down> gj',
  'inoremap <Up> <C-o>gk',
  'inoremap <Down> <C-o>gj',
  '',
  '" Wrap at word boundaries, textarea-style.',
  'set wrap linebreak',
  '',
  '" Minimal chrome: no statusline or cmdline row; hide the end-of-buffer',
  '" tildes and the "<<<" wrapped-line marker (fillchars firstline:<empty>).',
  'set laststatus=0',
  'set cmdheight=0',
  'set fillchars+=eob:\\ ,firstline:',
  '',
].join('\n');

// ---- the persistent config store (IndexedDB) -------------------------------

let db: IDBDatabase | null = null;
// In-memory mirror of the store: config-dir-relative path -> file content.
// Kept synchronously current so engine seeding never waits on IDB.
let configFiles: Record<string, string> = {};

function openDb(): Promise<IDBDatabase> {
  return new Promise(function (resolve, reject) {
    const req = indexedDB.open('nvim-config', 1);
    req.onupgradeneeded = function () { req.result.createObjectStore('files'); };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function loadConfig(): Promise<void> {
  return openDb().then(function (d) {
    db = d;
    return new Promise<void>(function (resolve, reject) {
      const tx = d.transaction('files', 'readonly').objectStore('files');
      const keysReq = tx.getAllKeys();
      const valsReq = tx.getAll();
      keysReq.onerror = valsReq.onerror = function (e: any) { reject(e.target.error); };
      valsReq.onsuccess = function () {
        const keys = keysReq.result || [];
        const vals = valsReq.result || [];
        for (let i = 0; i < keys.length; i++) { configFiles[String(keys[i])] = String(vals[i]); }
        resolve();
      };
    });
  });
}

function idbWrite(rel: string, text: string | null): void {
  if (!db) { return; }
  try {
    const store = db.transaction('files', 'readwrite').objectStore('files');
    if (text === null) { store.delete(rel); } else { store.put(text, rel); }
  } catch (e) {
    console.warn('[nvim-textarea] config store write failed:', e);
  }
}

// Reject anything that could escape the config dir when replayed as a seed
// path (the hooks only report real subpaths; this is defense in depth).
function badRel(rel: any): boolean {
  return typeof rel !== 'string' || rel === '' || rel.charAt(0) === '/' ||
    rel.split('/').indexOf('..') !== -1;
}

function onConfigWrite(rel: string, text: string): void {
  if (badRel(rel) || typeof text !== 'string') { return; }
  // Content-equal writes are ignored: every boot's seeding echoes the seeded
  // files back through the FS hooks, and this check is what stops that echo
  // from respawning the warm engine forever.
  if (configFiles[rel] === text) { return; }
  configFiles[rel] = text;
  idbWrite(rel, text);
  refreshWarm();
}

function onConfigUnlink(rel: string): void {
  if (badRel(rel) || !(rel in configFiles)) { return; }
  delete configFiles[rel];
  idbWrite(rel, null);
  refreshWarm();
}

// The `filesystem` init payload: the stored tree, plus the default init.vim
// when the store has none (first run / user deleted it).
function seedFilesystem(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const rel in configFiles) {
    if (Object.prototype.hasOwnProperty.call(configFiles, rel)) {
      files[CONFIG_DIR + '/' + rel] = configFiles[rel];
    }
  }
  if (!('init.vim' in configFiles)) {
    files[CONFIG_DIR + '/init.vim'] = DEFAULT_INIT_VIM;
  }
  return files;
}

// ---- engines ---------------------------------------------------------------

interface Engine {
  worker: Worker;
  dead: boolean;
  // Set when the engine is terminated (replaced warm engine, ended session).
  // postMessages already in flight from the worker may still deliver after
  // terminate(); this flag keeps a stale engine's config echo from
  // overwriting fresher stored config.
  dropped: boolean;
  // Messages produced before a session claims this engine (boot statuses),
  // replayed on claim.
  pending: any[];
  deliver: ((m: any) => void) | null;
}

function dropEngine(eng: Engine): void {
  eng.dropped = true;
  eng.dead = true;
  eng.deliver = null;
  try { eng.worker.terminate(); } catch (_e) {}
}

function spawnEngine(): Engine {
  const eng: Engine = {
    worker: new Worker('ext-engine-worker.js'),
    dead: false,
    dropped: false,
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
    // Config-persistence events from the FS hooks: handled here, never
    // forwarded to the session. Dropped engines' late echoes are ignored.
    if (d && (d.kind === 'config-write' || d.kind === 'config-unlink')) {
      if (!eng.dropped) {
        if (d.kind === 'config-write') { onConfigWrite(d.path, d.text); } else { onConfigUnlink(d.path); }
      }
      return;
    }
    if (d && d.kind === 'exit') { eng.dead = true; }
    emit({ t: 'status', s: d });
  };
  eng.worker.onerror = function (e: any) {
    emit({ t: 'status', s: { kind: 'error', error: String(e && e.message || e) } });
  };
  // The engine worker's init message (see wasm/web/src/engine-worker.ts): it
  // prepends --embed to args; `plugins` picks the runtime variant baked into
  // the bundle by build-ext.sh (ext-config.js); `filesystem` seeds the
  // persisted user config (materialized in MEMFS before main()).
  eng.worker.postMessage({
    args: ['-n'],
    plugins: CFG.plugins || 'core',
    filesystem: seedFilesystem(),
  });
  return eng;
}

// The pre-warmed engine. Booted once the stored config is loaded (background
// creates this document on install/startup), replaced on claim, and REPLACED
// EAGERLY when the config changes -- a warm engine seeded with a stale config
// must never serve a session.
let warm: Engine | null = null;

const configReady: Promise<void> = loadConfig()
  .catch(function (e) {
    console.warn('[nvim-textarea] config store unavailable; using defaults:', e);
  })
  .then(function () { warm = spawnEngine(); });

function refreshWarm(): void {
  if (warm) { dropEngine(warm); }
  warm = spawnEngine();
}

function claimEngine(): Engine {
  let eng = warm;
  warm = null;
  if (!eng || eng.dead) {
    // The warm engine crashed/exited while idle (or this raced): boot fresh.
    if (eng) { dropEngine(eng); }
    eng = spawnEngine();
  }
  warm = spawnEngine();
  return eng;
}

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== NvimExt.PORT_NAME) { return; }

  // Binding waits for the config store (only relevant in the first moments of
  // the document's life); buffer anything the session sends meanwhile.
  let eng: Engine | null = null;
  let disconnected = false;
  const early: any[] = [];

  function feed(engine: Engine, m: any): void {
    if (!m || m.t !== 'rpc' || engine.dead) { return; }
    const u8 = NvimExt.bytesFromB64(m.b);
    engine.worker.postMessage(u8.buffer, [u8.buffer]);
  }

  port.onMessage.addListener(function (m) {
    if (eng) { feed(eng, m); } else { early.push(m); }
  });
  port.onDisconnect.addListener(function () {
    // Session over (overlay closed, tab navigated/closed). The engine is
    // per-session; tear it down.
    disconnected = true;
    if (eng) { dropEngine(eng); }
  });

  configReady.then(function () {
    if (disconnected) { return; }
    eng = claimEngine();
    eng.deliver = function (m) {
      try { port.postMessage(m); } catch (_e) { /* port gone; disconnect handler cleans up */ }
    };
    const backlog = eng.pending.splice(0);
    for (let i = 0; i < backlog.length; i++) { eng.deliver(backlog[i]); }
    for (let i = 0; i < early.length; i++) { feed(eng, early[i]); }
  });
});
