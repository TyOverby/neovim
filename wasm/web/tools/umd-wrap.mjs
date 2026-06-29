// wasm/web/tools/umd-wrap.mjs - wrap a tsc-emitted CommonJS module into a UMD
// module that ALSO sets a browser global.
//
// tsc's own `module: umd` is deprecated (TS 6) and, more importantly, does NOT
// assign a named global -- it only handles CommonJS + AMD. But neovim.js et al.
// must remain loadable as a plain <script> that sets globalThis.<Name> (the
// browser demo + build-site/build-lib bundles rely on it), AND via require() in
// Node (the e2e / reconnect tests), AND via importScripts-style classic loads.
//
// So the build compiles the TS source to a self-contained CommonJS module (the
// core modules have no imports, so the body only ever touches `exports`), and
// this tool wraps that body: in a CommonJS host it populates module.exports; in
// a browser <script> (no module/exports) it builds a fresh exports object and
// hangs it off the global as root.<Name>. Behaviour matches the hand-written UMD
// the TS port replaced.
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
