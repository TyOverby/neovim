-- Tests for 'fillchars' items with behavior beyond a plain character swap.
-- The "firstline" item controls the "<<<" marker drawn over the start of the
-- first screen line when part of the line is above the window (w_skipcol > 0):
-- a character replaces the marker's '<', and an EMPTY value disables the
-- marker entirely, showing the text it would otherwise overwrite.

local n = require('test.functional.testnvim')()
local Screen = require('test.functional.ui.screen')

local clear = n.clear
local command = n.command
local exec = n.exec
local feed = n.feed

before_each(clear)

describe("'fillchars' firstline item", function()
  local screen

  -- A 20x6 window whose buffer is ONE long wrapped line; moving to the end
  -- scrolls the window into the middle of the line (w_skipcol > 0), which is
  -- what triggers the marker.
  before_each(function()
    screen = Screen.new(20, 6)
    exec([[
      set wrap laststatus=0
      call setline(1, 'word '->repeat(40))
      normal! $
    ]])
  end)

  it('defaults to the "<<<" marker overwriting text', function()
    screen:expect([[
      {1:<<<}d word word word |
      word word word word |*3
      word word word word^ |
                          |
    ]])
  end)

  it('a character replaces the marker', function()
    command('set fillchars=firstline:+')
    screen:expect([[
      {1:+++}d word word word |
      word word word word |*3
      word word word word^ |
                          |
    ]])
  end)

  it('an empty value disables the marker and shows the text', function()
    command('set fillchars=firstline:')
    screen:expect([[
      word word word word |*4
      word word word word^ |
                          |
    ]])
  end)

  it("works with 'smoothscroll' scrolling", function()
    command('set smoothscroll fillchars=firstline:')
    feed('gg<C-E>')
    screen:expect([[
      ^word word word word |
      word word word word |
      word word word word |
      word word word word |
      word word word word |
                          |
    ]])
  end)
end)
