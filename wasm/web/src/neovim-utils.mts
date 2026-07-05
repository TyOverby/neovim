// wasm/web/src/neovim-utils.mts - ESM entry point for the high-level helpers.
//
// Same shape and rationale as neovim-ui.mts: the UMD module (neovim-utils.js)
// stays the single source of truth (still a <script> global / require()-able),
// and this thin ESM wrapper imports it for its side effect of populating the
// global, then re-exports the same named surface plus a default. See neovim.mts
// for the full explanation of why this is browser-correct with no bundler.
import './neovim-utils.js';
import type {
  UtilsInstance, AutocmdPayload, AutocmdHandle,
} from './neovim-utils.js';

const ns: any =
  (typeof globalThis !== 'undefined' && (globalThis as any).NeovimUtils) ||
  ((await import('./neovim-utils.js')) as any).default ||
  {};

export const open_file_in_editor: (instance: UtilsInstance, path: string) => Promise<any> = ns.open_file_in_editor;
export const read_file: (instance: UtilsInstance, path: string) => Promise<string | null> = ns.read_file;
export const write_file: (instance: UtilsInstance, path: string, content: string) => Promise<any> = ns.write_file;
export const create_autocmd: (instance: UtilsInstance, events: string | string[], opts?: Record<string, any>) => Promise<number> = ns.create_autocmd;
export const add_notify_handler: (instance: UtilsInstance, name: string, fn: (params: any) => void) => (() => void) = ns.add_notify_handler;
export const on_autocmd: (instance: UtilsInstance, events: string | string[], opts: Record<string, any> | null | undefined, fn: (payload: AutocmdPayload) => void) => Promise<AutocmdHandle> = ns.on_autocmd;

export type { UtilsInstance, AutocmdPayload, AutocmdHandle } from './neovim-utils.js';

export default ns;
