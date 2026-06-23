// wasm/web/neovim-utils.mjs - ESM entry point for the high-level helpers.
//
// Same shape and rationale as neovim-ui.mjs: the UMD module (neovim-utils.js)
// stays the single source of truth (still a <script> global / require()-able),
// and this thin ESM wrapper imports it for its side effect of populating the
// global, then re-exports the same named surface plus a default. See neovim.mjs
// for the full explanation of why this is browser-correct with no bundler.
import './neovim-utils.js';

const ns =
  (typeof globalThis !== 'undefined' && globalThis.NeovimUtils) ||
  (await import('./neovim-utils.js')).default ||
  {};

export const open_file_in_editor = ns.open_file_in_editor;
export const read_file = ns.read_file;
export const write_file = ns.write_file;
export const create_autocmd = ns.create_autocmd;
export const add_notify_handler = ns.add_notify_handler;
export const on_autocmd = ns.on_autocmd;

export default ns;
