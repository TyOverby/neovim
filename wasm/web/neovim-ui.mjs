// wasm/web/neovim-ui.mjs - ESM entry point for the default UI renderer.
//
// Same shape and rationale as neovim.mjs: the UMD module (neovim-ui.js) stays
// the single source of truth (still a <script> global / require()-able), and
// this thin ESM wrapper imports it for its side effect of populating the global,
// then re-exports the same named surface plus a default. See neovim.mjs for the
// full explanation of why this is browser-correct with no bundler.
import './neovim-ui.js';

const ns =
  (typeof globalThis !== 'undefined' && globalThis.NeovimUI) ||
  (await import('./neovim-ui.js')).default ||
  {};

export const Screen = ns.Screen;
export const mount_into = ns.mount_into;
export const keyToNvim = ns.keyToNvim;

export default ns;
