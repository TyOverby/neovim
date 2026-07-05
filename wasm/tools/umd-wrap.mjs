// wasm/tools/umd-wrap.mjs - wrap a tsc-emitted CommonJS module into a UMD module
// that ALSO sets a global (Node `module.exports` OR classic-worker `self.<Name>`).
//
// proxy-client.js / proxy-reconnect.js must load BOTH as a Node module (require,
// from worker.js / wasm/web's reconnect.test.js) AND in a classic Web Worker via
// importScripts (where they set self.ProxyClient / self.ProxyReconnect, read by
// wasm/web/src/engine-worker.ts). tsc's own `module: umd` is deprecated and does
// not assign a global, so the build compiles the TS to a self-contained CommonJS
// module (the proxy sources have no imports, so the body only touches `exports`)
// and this tool wraps it. Mirrors wasm/web/tools/umd-wrap.mjs.
//
//   Usage: node umd-wrap.mjs <in.cjs.js> <out.js> <GlobalName>
import { readFileSync, writeFileSync } from 'node:fs';

const [, , infile, outfile, globalName] = process.argv;
if (!infile || !outfile || !globalName) {
  console.error('usage: umd-wrap.mjs <in> <out> <GlobalName>');
  process.exit(1);
}

const body = readFileSync(infile, 'utf8');
const out =
`(function (root, factory) {
  if (typeof module === 'object' && module.exports) { factory(module, module.exports); }
  else { var m = { exports: {} }; factory(m, m.exports); root.${globalName} = m.exports; }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function (module, exports) {
${body}
});
`;
writeFileSync(outfile, out);
