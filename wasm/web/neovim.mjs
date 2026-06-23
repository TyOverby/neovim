// wasm/web/neovim.mjs - ESM entry point for the headless msgpack-RPC core.
//
// WHY THIS SHAPE: the source of truth stays the hand-written UMD module
// (neovim.js). The UMD file remains usable as a <script> global, via require()
// in Node, and via importScripts() in the engine worker -- none of which we may
// break. Rather than fork the implementation or add a bundler, this ESM file
// imports neovim.js purely for its SIDE EFFECT of populating a global, then
// re-exports the same API as proper ESM named + default exports.
//
// This works in a real browser with no build step: when neovim.js runs in ESM
// module scope, `module`/`exports` are undefined, so its UMD wrapper takes the
// `else` branch and assigns to `root.Neovim`, where `root` resolves to the
// global (`self` in a browser/worker, else `globalThis`). We read it back off
// `globalThis` here. In Node ESM the UMD `module.exports` branch is taken
// instead and the global is not set, so we fall back to a dynamic `import()` of
// the CommonJS module via its default export. Either way the named surface below
// is identical to the UMD object.
import './neovim.js';

const ns =
  (typeof globalThis !== 'undefined' && globalThis.Neovim) ||
  (await import('./neovim.js')).default ||
  {};

// MessagePack injection: an embedder who `import`s this ESM entry must NOT have
// to separately load the @msgpack/msgpack UMD global. neovim.js's createNvim()
// only falls back to a `MessagePack` GLOBAL (present on the UMD <script> page,
// but absent in an ESM context), so we resolve a MessagePack namespace here and
// default it into create()/createNvim() when the caller passes none.
//
// Resolution order (per call, in withMessagePack below):
//   1. opts.MessagePack          - caller override, always wins
//   2. globalThis.MessagePack    - the UMD global, if the embedder loaded it
//   3. the bundled ESM build     - ./msgpack.esm/index.mjs, copied next to us by
//                                  build-lib.sh (the @msgpack/msgpack dist.esm)
//
// The bundled import is attempted ONCE here and wrapped in try/catch so that in
// the RAW SOURCE TREE (where ./msgpack.esm/ does not exist) it fails SOFTLY:
// importing this module still succeeds; only a create() with no MessagePack
// available anywhere errors -- and then with neovim.js's clear message. Top-level
// await is valid ESM and is what lets us resolve the dynamic import before the
// wrapped create()/createNvim() are first called.
let bundledMP = null;
try {
  bundledMP = await import('./msgpack.esm/index.mjs');
} catch (_e) {
  bundledMP = null;   // not bundled (e.g. running from the source tree) -- fine.
}

function withMessagePack(opts) {
  opts = opts || {};
  if (opts.MessagePack) { return opts; }   // caller override wins; don't clobber.
  var mp = (typeof globalThis !== 'undefined' && globalThis.MessagePack) || bundledMP;
  if (!mp) { return opts; }                // none available: let createNvim error clearly.
  return Object.assign({}, opts, { MessagePack: mp });
}

export function create(opts) { return ns.create(withMessagePack(opts)); }
export function createNvim(opts) { return ns.createNvim(withMessagePack(opts)); }
export const enableClipboard = ns.enableClipboard;
export const browserEngineTransport = ns.browserEngineTransport;
export const resolveEngineUrl = ns.resolveEngineUrl;
export const ByteQueue = ns.ByteQueue;

// `default` mirrors the wrapped surface, so `import neovim from '...'`-style use
// (`neovim.create(...)`) also gets the auto-injected MessagePack.
export default Object.assign({}, ns, { create: create, createNvim: createNvim });
