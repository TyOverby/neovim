-- adopt_spike.lua — de-risk the durable-:terminal "adopt" primitive.
--
-- The cold-case rehydration plan binds a RESTORED terminal buffer to an
-- already-running pty owned elsewhere (the session-host daemon) via
-- nvim_open_term(), instead of respawning. The one unknown is whether
-- nvim_open_term + on_input + chansend faithfully proxy a real pty's byte stream
-- bidirectionally — i.e. whether an "adopted" terminal behaves like a real one.
--
-- This spike stands the daemon's pty in as a jobstart{pty=true} child (a real pty
-- nvim does NOT render itself), and drives it entirely through a SEPARATE
-- nvim_open_term buffer: pty output -> chansend(term); terminal-mode keypresses ->
-- on_input -> chansend(job stdin). If a real pty's output renders and typed input
-- round-trips, the primitive holds and the rest of the feature is plumbing.
--
-- Run: build/bin/nvim --headless -l wasm/spikes/stage5-durable-term-adopt/adopt_spike.lua

local fails = 0
local function check(name, ok)
  io.stderr:write((ok and "PASS  " or "FAIL  ") .. name .. "\n")
  if not ok then fails = fails + 1 end
end

-- A terminal buffer in the current window (so it has a real size to render into).
local buf = vim.api.nvim_create_buf(false, true)
vim.api.nvim_set_current_buf(buf)

local job -- forward decl: the stand-in "daemon pty"

-- on_input: terminal-mode keypresses -> the external pty's stdin. This is the
-- exact forwarding our adopted terminal will do (to daemon pty.write). Named so
-- the spike can invoke it directly (see the input check below).
local function forward_input(_, _, _, data)
  if job then pcall(vim.fn.chansend, job, data) end
end

-- The adopted terminal: bound to an external byte stream, NOT a spawned process.
local term = vim.api.nvim_open_term(buf, { on_input = forward_input })
check("nvim_open_term created", term > 0)

-- The stand-in pty: clear screen, print a marker, then a read-loop that echoes
-- each line (so input round-trips), with a WINCH trap that reports the new size
-- (a read-loop, unlike `cat`, lets sh run its trap on SIGWINCH).
local script = [[
trap 'printf "WINCH %s\r\n" "$(stty size 2>/dev/null)"' WINCH
printf '\033[2J\033[H'
printf 'ADOPT-OUTPUT-OK\r\n'
while IFS= read -r line; do printf '%s\r\n' "$line"; done
]]
job = vim.fn.jobstart({ "sh", "-c", script }, {
  pty = true,
  width = 80,
  height = 24,
  on_stdout = function(_, data, _)
    -- External pty output -> rendered into the adopted terminal buffer.
    pcall(vim.fn.chansend, term, data)
  end,
})
check("external pty started", job > 0)

local function buf_has(text)
  for _, l in ipairs(vim.api.nvim_buf_get_lines(buf, 0, -1, false)) do
    if l:find(text, 1, true) then return true end
  end
  return false
end

-- 1) Output: the external pty's bytes render in the adopted buffer.
vim.wait(3000, function() return buf_has("ADOPT-OUTPUT-OK") end, 20)
check("renders external pty output", buf_has("ADOPT-OUTPUT-OK"))

-- 2) Input round-trip: invoke the registered on_input handler as a Terminal-Job
-- keypress would, and confirm the byte forwards to the pty and its echo renders.
-- (The keypress -> on_input DISPATCH is core nvim, exercised by nvim's UI-attached
-- terminal tests; a headless `-l` script can't enter Terminal-Job mode, so we call
-- the handler directly to prove OUR forwarding path — the only novel part.)
forward_input(nil, nil, nil, "PINGPONG\r")
vim.wait(2000, function() return buf_has("PINGPONG") end, 20)
check("on_input forwards to pty (echo round-trips)", buf_has("PINGPONG"))

-- 3) Resize: jobresize drives the pty winsize; the child's WINCH trap reports the
-- new size as "WINCH <rows> <cols>".
vim.fn.jobresize(job, 100, 30)
vim.wait(2000, function() return buf_has("WINCH 30 100") end, 20)
check("pty resize propagates", buf_has("WINCH 30 100"))

pcall(vim.fn.jobstop, job)
io.stderr:write(fails == 0 and "\nSPIKE: ALL PASS\n" or ("\nSPIKE: " .. fails .. " FAIL\n"))
vim.cmd(fails == 0 and "cq 0" or "cq 1")
