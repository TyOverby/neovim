# Spike: dynamically loading tree-sitter grammars in the wasm build (2026-07-03)

**Question.** The bundled grammars are statically linked into `nvim.wasm`
(wasm has no dlopen by default). Could the wasm build *dynamically* load
grammar `.wasm` files — the tree-sitter project's official portable format,
which are Emscripten **side modules** — so users get a
"drop a prebuilt grammar into `parser/` and it works" story, like native
nvim's `parser/<lang>.so` (or its opt-in wasmtime `.wasm` loader)?

**Answer: YES — proven end to end.** With the engine linked as an Emscripten
main module, nvim's *existing* dlopen loader (`load_language_from_object` →
`uv_dlopen`) loads an emcc side-module grammar with no C changes at all.

## What was run

1. Build a grammar as a side module (the same shape `tree-sitter build --wasm`
   emits) — see `build-side-module.sh`:

   ```sh
   emcc -O2 -sSIDE_MODULE=2 -sSUPPORT_LONGJMP=wasm \
     -sEXPORTED_FUNCTIONS=_tree_sitter_lua \
     -I <lua-grammar>/src <lua-grammar>/src/parser.c <lua-grammar>/src/scanner.c \
     -o luadyn.so                      # 56 KB
   ```

2. Rebuild the engine as a main module. **Everything** (deps + nvim) must be
   compiled `-fPIC` — `-sMAIN_MODULE` makes the main module itself relocatable,
   and non-PIC objects fail the link with `relocation R_WASM_MEMORY_ADDR_*
   cannot be used against symbol X; recompile with -fPIC`:

   ```sh
   rm -rf .deps-wasm && EMCC_CFLAGS="-fPIC" wasm/build-deps.sh
   wasm/build-nvim.sh "-DCMAKE_C_FLAGS=-fPIC" \
     "-DCMAKE_EXE_LINKER_FLAGS=-sMAIN_MODULE=2 -sEXPORTED_FUNCTIONS=_main,_malloc,_calloc,_realloc,_free,_iswspace"
   ```

3. Probe (`probe.lua`, headless `-l`): register the side module under a
   NON-builtin name so the static registry can't satisfy it — the
   third-party-grammar simulation:

   ```lua
   vim.treesitter.language.add('luadyn', { path = '.../luadyn.so', symbol_name = 'lua' })
   ```

## Results

| Check | Result |
|---|---|
| `language.add` via explicit path (dlopen + dlsym) | ✅ returns `true` |
| Parse: `get_string_parser('local x = 1','luadyn'):parse()` | ✅ root `chunk` → `variable_declaration` |
| Query against the loaded grammar (`'"local" @kw'`) | ✅ captures; invalid node types are rejected against the *loaded* grammar's node table |
| External scanner (C, uses `iswspace`) | ✅ runs (after export fix below) |
| Same file named `.wasm` | ❌ `loadparser` routes `.wasm` → the absent wasmtime loader (`vim._ts_add_language_from_wasm`) → "Cannot load parser". **Production needs a one-line routing tweak** (send `.wasm` down the object/dlopen path in the emscripten build). |
| Boot gates (full/core/minimal) | ✅ all boot clean |
| `wasm/web/treesitter.test.js` + `wasm/web/e2e.test.js` (JSPI health) | ✅ all pass |
| tvim browser e2e (real Chrome, JSPI) | ✅ passes |
| `nvim.wasm` size | 7.07 MB → **8.00 MB** (+0.9 MB, +13%) |
| Boot (`--version` under Node, wall) | 0.14 s — no visible regression |

## Gotchas found

* **`-fPIC` everywhere.** Deps AND nvim objects. Two full rebuilds needed
  (deps once, nvim once); the deps configure tree must be rebuilt from
  scratch (`rm -rf .deps-wasm`).
* **`MAIN_MODULE=2` DCEs libc exports the side module needs.** Unresolved
  side-module imports do NOT fail dlopen — they become lazy JS stubs that
  crash **at first call** with `TypeError: resolved is not a function`
  (`free` and `iswspace` in this spike; `calloc` came along free with the
  dynamic-linker runtime). Production wants a curated export list covering
  what grammar scanners typically use: the alloc family + `mem*` + the
  `isw*`/`tow*` wctype family (or `-sMAIN_MODULE=1`, which exports everything
  but costs more size and disables DCE). Consider a load-time import check
  for a clean error instead of the lazy-stub crash.
* **C++ scanners won't load** — the C-only main module exports no libc++
  symbols. The ecosystem has largely migrated scanners to C, but old grammar
  builds exist.
* **emcc ABI drift** is the remaining compatibility surface for grammars
  built by *other people's* emscripten versions (the dylink ABI is fairly
  stable; web-tree-sitter has lived with this for years).

## Productionization sketch (not done in this spike)

1. Bake `-fPIC` into `build-deps.sh`/`build-nvim.sh` and the `MAIN_MODULE=2`
   + curated `EXPORTED_FUNCTIONS` into the EMSCRIPTEN link block.
2. Route `.wasm` grammar files to `_ts_add_language_from_object` when the
   wasmtime loader is absent (guarded, in `language.lua` or by defining the
   loader C-side under `__EMSCRIPTEN__`).
3. Tests: extend `wasm/web/treesitter.test.js` with a side-module fixture
   (build it in the test or check in the 56 KB artifact); browser e2e:
   drop a grammar on the tvim server FS under `parser/` and `language.add` it.
4. Decide whether the +13% wasm size is paid by everyone or gated behind a
   second engine artifact (`nvim-dyn.wasm`), since `.data`/runtime variants
   already prove the multi-artifact pattern.
