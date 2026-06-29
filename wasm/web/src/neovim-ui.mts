// wasm/web/src/neovim-ui.mts - ESM entry point for the default UI renderer.
//
// Same shape and rationale as neovim.mts: the UMD module (neovim-ui.js) stays
// the single source of truth (still a <script> global / require()-able), and
// this thin ESM wrapper imports it for its side effect of populating the global,
// then re-exports the same named surface plus a default. See neovim.mts for the
// full explanation of why this is browser-correct with no bundler.
import './neovim-ui.js';
import type { Screen as ScreenType, MountHandle, MountOptions, UIInstance } from './neovim-ui.js';

const ns: any =
  (typeof globalThis !== 'undefined' && (globalThis as any).NeovimUI) ||
  ((await import('./neovim-ui.js')) as any).default ||
  {};

export const Screen: typeof ScreenType = ns.Screen;
export const mount_into: (instance: UIInstance, el: HTMLElement, opts?: MountOptions) => MountHandle = ns.mount_into;
export const keyToNvim: (e: KeyboardEvent) => string | null = ns.keyToNvim;

export type { MountHandle, MountOptions, UIInstance, HlAttrs } from './neovim-ui.js';

export default ns;
