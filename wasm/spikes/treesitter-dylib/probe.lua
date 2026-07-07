-- Spike probe: dynamically load an emscripten SIDE_MODULE grammar via the
-- existing dlopen path, registered under a NON-builtin name so the static
-- registry can't satisfy it (third-party-grammar simulation).
local so = _G.arg[1]
local out = {}

-- 1. dlopen path (.so extension routes to _ts_add_language_from_object)
local ok, res, err = pcall(vim.treesitter.language.add, 'luadyn', { path = so, symbol_name = 'lua' })
out.add_pcall_ok = ok
out.add_res = res
out.add_err = err or (not ok and tostring(res)) or nil

if ok and res == true then
  local p = vim.treesitter.get_string_parser('local x = 1', 'luadyn')
  local tree = p:parse()[1]
  out.root = tree:root():type()
  out.sexpr = tree:root():child(0) and tree:root():child(0):type() or nil
  -- prove it's a real, working TSLanguage: query an anonymous token
  local q = vim.treesitter.query.parse('luadyn', '"local" @kw')
  for id, _ in q:iter_captures(tree:root(), 'local x = 1') do
    out.capture = q.captures[id]
  end
end

-- 2. the same file named .wasm: today loadparser routes .wasm to the (absent)
--    wasmtime loader; document what happens.
local wasm_path = so:gsub('%.so$', '.wasm')
local ok2, res2, err2 = pcall(vim.treesitter.language.add, 'luadyn2', { path = wasm_path, symbol_name = 'lua' })
out.wasm_pcall_ok = ok2
out.wasm_res = res2
out.wasm_err = err2 or (not ok2 and tostring(res2)) or nil

io.write('SPIKE:' .. vim.json.encode(out) .. '\n')
