// wasm/chrome-ext/src/chrome-api.d.ts - minimal ambient typings for the few
// chrome.* extension APIs this extension touches. Deliberately NOT @types/chrome
// (no new npm dependency for a handful of calls); only the surface we use, kept
// loose where the shapes don't matter.

// UMD globals loaded before the scripts that use them (see background.ts's
// OVERLAY_FILES and offscreen.html): the neovim core/UI libraries and the
// extension's shared helpers. Declared here (once, ambiently) because the
// per-target tsc passes compile several classic scripts together and top-level
// `declare const` in two of them would collide.
declare const Neovim: any;
declare const NeovimUI: any;
declare const NvimExt: any;

interface ChromePort {
  name: string;
  postMessage(msg: any): void;
  disconnect(): void;
  onMessage: { addListener(fn: (msg: any) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

interface ChromeMessageSender {
  tab?: { id?: number };
  frameId?: number;
}

declare const chrome: {
  runtime: {
    lastError?: { message?: string } | undefined;
    connect(connectInfo?: { name?: string }): ChromePort;
    sendMessage(msg: any, callback?: (resp: any) => void): void;
    onConnect: { addListener(fn: (port: ChromePort) => void): void };
    onMessage: {
      addListener(
        fn: (msg: any, sender: ChromeMessageSender, sendResponse: (r?: any) => void) => boolean | void
      ): void;
    };
    onInstalled: { addListener(fn: () => void): void };
    onStartup: { addListener(fn: () => void): void };
  };
  offscreen: {
    hasDocument(): Promise<boolean>;
    createDocument(opts: { url: string; reasons: string[]; justification: string }): Promise<void>;
  };
  scripting: {
    executeScript(opts: {
      target: { tabId: number; frameIds?: number[] };
      files?: string[];
      func?: () => void;
    }): Promise<any>;
  };
};
