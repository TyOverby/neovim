// wasm/grid-renderer/tools/bundle-umd.mjs - link a tsc-emitted CommonJS
// module TREE into one UMD file that also sets a browser global.
//
// The wasm/web build wraps single-file CommonJS modules with umd-wrap.mjs;
// grid-renderer is multi-module (src/draw/* etc.), so this is the multi-file
// analog: every dist/cjs/**/*.js becomes an entry in an inline module map
// with a tiny relative-path require, and the entry module's exports become
// module.exports (CommonJS host) or root.<Name> (browser <script>). No
// external bundler - the linker is these ~60 lines.
//
//   Usage: node bundle-umd.mjs <cjs-dir> <entry-id> <out.js> <GlobalName>
//   e.g.:  node bundle-umd.mjs dist/cjs index dist/grid-renderer.js GridRenderer
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

const [, , cjsDir, entryId, outfile, globalName] = process.argv;
if (!cjsDir || !entryId || !outfile || !globalName) {
  console.error('usage: bundle-umd.mjs <cjs-dir> <entry-id> <out.js> <GlobalName>');
  process.exit(1);
}

function collect(dir, prefix) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...collect(full, prefix ? prefix + '/' + name : name));
    } else if (name.endsWith('.js')) {
      const id = (prefix ? prefix + '/' : '') + name.slice(0, -3);
      out.push([id, readFileSync(full, 'utf8')]);
    }
  }
  return out;
}

const modules = collect(cjsDir, '');
if (!modules.some(([id]) => id === entryId)) {
  console.error(`bundle-umd: entry '${entryId}' not found under ${cjsDir}`);
  process.exit(1);
}

const parts = [];
parts.push(`(function (root, factory) {
  if (typeof module === 'object' && module.exports) { factory(module, module.exports); }
  else { var m = { exports: {} }; factory(m, m.exports); root.${globalName} = m.exports; }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function (module, exports) {
var __modules = Object.create(null);
`);
for (const [id, body] of modules) {
  parts.push(`__modules[${JSON.stringify(id)}] = function (module, exports, require) {\n${body}\n};\n`);
}
parts.push(`var __cache = Object.create(null);
function __resolve(fromId, req) {
  if (req.charAt(0) !== '.') { throw new Error('grid-renderer bundle: external require: ' + req); }
  var parts = fromId.split('/'); parts.pop();
  var segs = req.split('/');
  for (var i = 0; i < segs.length; i++) {
    var s = segs[i];
    if (s === '.' || s === '') { continue; }
    else if (s === '..') { parts.pop(); }
    else { parts.push(s); }
  }
  var id = parts.join('/');
  if (id.slice(-3) === '.js') { id = id.slice(0, -3); }
  return id;
}
function __load(id) {
  if (__cache[id]) { return __cache[id].exports; }
  var fn = __modules[id];
  if (!fn) { throw new Error('grid-renderer bundle: unknown module: ' + id); }
  var m = { exports: {} };
  __cache[id] = m;
  fn(m, m.exports, function (req) { return __load(__resolve(id, req)); });
  return m.exports;
}
module.exports = __load(${JSON.stringify(entryId)});
});
`);

writeFileSync(outfile, parts.join(''));
console.log(`bundle-umd: ${modules.length} modules -> ${outfile} (global ${globalName})`);
