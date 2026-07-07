// wasm/chrome-ext/src/ext-common.ts - helpers shared by both sides of the
// extension's session bridge (overlay.js in the content-script world and
// offscreen.js in the offscreen document).
//
// WHY BASE64: the two sides talk over a chrome.runtime Port, and extension
// message passing is JSON-serialized -- an ArrayBuffer silently becomes {}.
// So the msgpack-RPC byte chunks ride the port base64-encoded. Compiled as a
// classic script (no modules); the helpers land on globalThis.NvimExt.
'use strict';

(function () {
  // Uint8Array -> base64. String.fromCharCode.apply has an argument-count
  // limit, so build the binary string in chunks.
  function b64FromBytes(u8: Uint8Array): string {
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK) as any);
    }
    return btoa(s);
  }

  function bytesFromB64(b: string): Uint8Array {
    const s = atob(b);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) { u8[i] = s.charCodeAt(i); }
    return u8;
  }

  (globalThis as any).NvimExt = {
    // The Port name a session connects with (overlay -> offscreen).
    PORT_NAME: 'nvim-session',
    b64FromBytes: b64FromBytes,
    bytesFromB64: bytesFromB64,
  };
})();
