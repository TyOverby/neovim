// wasm/chrome-ext/src/overlay.ts - the in-page editing session.
//
// Injected on demand (with msgpack/grid-renderer/neovim/neovim-ui, see
// background.ts) into the content-script world. For each activated <textarea>
// it runs one SESSION:
//
//   * overlays a <canvas> (fixed-position, sized to the textarea with a
//     usability floor) on top of the textarea,
//   * connects a chrome.runtime Port to the offscreen engine host and adapts
//     it into a neovim.js Transport (RPC bytes ride the port base64-encoded --
//     extension messaging is JSON-only),
//   * boots the standard library stack over it: Neovim.createNvim() +
//     NeovimUI.mount_into() -- the exact same core/renderer that the demo page
//     uses, only the transport differs,
//   * loads the textarea's content into the buffer and installs a BufWriteCmd
//     autocmd, so `:w` pushes the buffer back into the textarea (dispatching
//     input/change events so frameworks notice),
//   * tears down when the engine exits -- `:q` / `:wq` / ZZ EXIT an --embed
//     nvim, so "quit" IS the session-end signal (write-then-exit = :wq). The
//     offscreen host keeps a replacement engine pre-warmed.
//
// The page never sees the keystrokes typed into the canvas bubble past it
// (mount_into preventDefaults; we additionally stop propagation at the canvas
// so document-level page hotkeys don't fire), but page listeners in the
// CAPTURE phase above the canvas run before us -- that's a platform limit.
'use strict';

(function () {
  const w = window as any;

  if (!w.__nvimOverlay) {
    // Active sessions by textarea, so re-triggering an already-overlaid
    // textarea focuses its session instead of double-opening.
    const sessions = new Map<HTMLTextAreaElement, { focus(): void }>();

    // Tiny floor so a degenerate textarea still yields a paintable grid; the
    // overlay otherwise matches the textarea's size exactly.
    const MIN_W = 60, MIN_H = 40, MARGIN = 8;

    // Set the textarea's OUTER (border-box) size to w x h CSS px, honoring its
    // box-sizing -- the same thing the native corner-drag does.
    function setTextareaSize(ta: HTMLTextAreaElement, w: number, h: number): void {
      const cs = getComputedStyle(ta);
      let dw = 0, dh = 0;
      if (cs.boxSizing !== 'border-box') {
        dw = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) +
             (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
        dh = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) +
             (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      }
      ta.style.width = Math.max(0, w - dw) + 'px';
      ta.style.height = Math.max(0, h - dh) + 'px';
    }

    // Set a textarea's value the way frameworks expect: through the native
    // setter (React et al. patch the prototype accessor to track edits), then
    // dispatch input/change so listeners and two-way bindings notice.
    function setTextareaValue(ta: HTMLTextAreaElement, text: string): void {
      const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      if (desc && desc.set) { desc.set.call(ta, text); } else { ta.value = text; }
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // A display name for the buffer (statusline / :ls); uniqueness doesn't
    // matter since every session runs its own engine.
    function bufferName(ta: HTMLTextAreaElement): string {
      const id = ta.id || ta.getAttribute('name') || 'textarea';
      return 'textarea://' + location.host + location.pathname + '#' + id;
    }

    // ---- theme: replicate the textarea's colors ---------------------------
    // Parse a computed CSS color ('rgb(r, g, b)' / 'rgba(r, g, b, a)' -- the
    // legacy form Chrome reports for computed styles). Returns {r,g,b,a} or
    // null for anything else (keywords never appear computed; wide-gamut
    // color() forms are rare enough to fall back on defaults).
    function parseCssColor(s: string): { r: number; g: number; b: number; a: number } | null {
      const m = /^rgba?\(([^)]+)\)$/.exec(s || '');
      if (!m) { return null; }
      const parts = m[1].split(',').map(function (x) { return parseFloat(x); });
      if (parts.length < 3 || parts.some(function (x) { return isNaN(x); })) { return null; }
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length >= 4 ? parts[3] : 1 };
    }

    // The textarea's EFFECTIVE background: walk up through transparent
    // ancestors, then composite any translucent layers (topmost last) over
    // the first opaque one (white if none -- the browser's canvas default).
    function effectiveBg(el: Element): { r: number; g: number; b: number } {
      const layers: Array<{ r: number; g: number; b: number; a: number }> = [];
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = parseCssColor(getComputedStyle(n).backgroundColor);
        if (!c || c.a <= 0) { continue; }
        layers.push(c);
        if (c.a >= 1) { break; }
      }
      let out = { r: 255, g: 255, b: 255 };
      for (let i = layers.length - 1; i >= 0; i--) {
        const l = layers[i];
        out = {
          r: l.r * l.a + out.r * (1 - l.a),
          g: l.g * l.a + out.g * (1 - l.a),
          b: l.b * l.a + out.b * (1 - l.a),
        };
      }
      return out;
    }

    function toInt(c: { r: number; g: number; b: number }): number {
      return (Math.round(c.r) << 16) | (Math.round(c.g) << 8) | Math.round(c.b);
    }

    // fg/bg as 24-bit ints + whether the bg reads as light (drives nvim's
    // 'background' option so the rest of the default colorscheme harmonizes).
    function textareaTheme(ta: HTMLTextAreaElement): { fg: number; bg: number; light: boolean } {
      const bg = effectiveBg(ta);
      const fgc = parseCssColor(getComputedStyle(ta).color) || { r: 0, g: 0, b: 0, a: 1 };
      const fg = fgc.a >= 1 ? fgc : {   // translucent text: composite over the bg
        r: fgc.r * fgc.a + bg.r * (1 - fgc.a),
        g: fgc.g * fgc.a + bg.g * (1 - fgc.a),
        b: fgc.b * fgc.a + bg.b * (1 - fgc.a),
      };
      const lum = (0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b) / 255;
      return { fg: toInt(fg), bg: toInt(bg), light: lum > 0.5 };
    }

    // Buffer-side session setup, run once the instance is ready:
    //   * name the buffer and make it write-through: 'acwrite' + a BufWriteCmd
    //     that rpcnotify()s the full buffer back to us (`:w` and the write half
    //     of `:wq`/`:x` both land here), then marks the buffer unmodified so
    //     the quit half proceeds without E37.
    //   * make plain `:q` DISCARD: QuitPre clears 'modified' so quitting a
    //     dirty buffer neither nags (E37) nor writes back -- in a textarea
    //     overlay, quit-without-write means "throw my edits away" (`:q!`
    //     semantics). Writes happen before the quit stage, so `:wq`/`ZZ`
    //     still push first.
    //   * navigate by DISPLAY line: textarea content is often one long
    //     soft-wrapped line, where plain j/k would jump a whole paragraph --
    //     remap j/k (normal+visual) and the arrow keys (incl. insert mode)
    //     to gj/gk.
    //   * soft-wrap long lines, textarea-style; no statusline and no
    //     end-of-buffer tildes (laststatus=0, fillchars eob:space) so the
    //     overlay reads as "the textarea, but nvim" rather than a full editor
    //     chrome.
    //   * replicate the textarea's colors: 'background' FIRST (setting it
    //     re-initializes the default colorscheme, so light-bg pages get
    //     readable syntax/UI groups), THEN the Normal override (the other
    //     order would wipe it).
    const SESSION_LUA = [
      'local chan, name, fg, bg, bgopt = ...',
      "pcall(function() vim.o.background = bgopt end)",
      "pcall(vim.api.nvim_set_hl, 0, 'Normal', { fg = fg, bg = bg })",
      'local buf = vim.api.nvim_get_current_buf()',
      'pcall(vim.api.nvim_buf_set_name, buf, name)',
      "vim.bo[buf].buftype = 'acwrite'",
      'vim.bo[buf].swapfile = false',
      'vim.wo.wrap = true',
      'vim.wo.linebreak = true',
      'vim.o.laststatus = 0',
      'vim.o.cmdheight = 0',
      // firstline:<empty> disables the "<<<" marker nvim draws OVER the
      // first three text cells when the window starts mid-way through a
      // soft-wrapped line (w_skipcol > 0 -- routine here: textarea content
      // is often one long line taller than the overlay). The empty-value
      // "firstline" fillchars item is this fork's feature (see 'fillchars'
      // in :help options): text stays fully visible, no marker, no indent.
      "vim.opt.fillchars:append({ eob = ' ', firstline = '' })",
      "vim.keymap.set({ 'n', 'v' }, 'j', 'gj')",
      "vim.keymap.set({ 'n', 'v' }, 'k', 'gk')",
      "vim.keymap.set('n', '<Up>', 'gk')",
      "vim.keymap.set('n', '<Down>', 'gj')",
      "vim.keymap.set('i', '<Up>', '<C-o>gk')",
      "vim.keymap.set('i', '<Down>', '<C-o>gj')",
      "vim.api.nvim_create_autocmd('BufWriteCmd', {",
      '  buffer = buf,',
      '  callback = function()',
      "    vim.rpcnotify(chan, 'nvim_textarea_write', vim.api.nvim_buf_get_lines(buf, 0, -1, false))",
      '    vim.bo[buf].modified = false',
      '  end,',
      '})',
      "vim.api.nvim_create_autocmd('QuitPre', {",
      '  buffer = buf,',
      '  callback = function() vim.bo[buf].modified = false end,',
      '})',
      'vim.bo[buf].modified = false',
    ].join('\n');

    // Clipboard: the library's browser provider (NOT a hand-rolled readText/
    // writeText wrapper) -- it carries the regtype recovery (last-write cache +
    // trailing-newline heuristic) that keeps `yy`/`p` linewise across the
    // plain-text system clipboard. Failures surface as RPC errors/warnings at
    // use time; clipboard is a nicety, not a session requirement.

    function open(ta: HTMLTextAreaElement): void {
      const existing = sessions.get(ta);
      if (existing) { existing.focus(); return; }

      // ---- overlay DOM ----------------------------------------------------
      const box = document.createElement('div');
      // Page-observable markers (the content-script world itself is invisible
      // to the page): present = session open, data-nvim-ready = buffer loaded
      // and writable. The e2e drives the extension through these.
      box.setAttribute('data-nvim-overlay', '');
      // Colors sampled from the textarea; applied to the overlay chrome here,
      // to the renderer defaults below (so the FIRST paint matches, before
      // the engine reports its colors), and to the engine's Normal group in
      // SESSION_LUA.
      const theme = textareaTheme(ta);
      const bgCss = '#' + (0x1000000 + theme.bg).toString(16).slice(1);

      // The BOX carries the explicit pixel size and, when the textarea is
      // resizable, the native resize handle -- `resize` does nothing on a
      // <canvas> (replaced element), so it must live on the div; the box's
      // resizer corner stays grabbable over the child canvas (like a
      // scrollbar, it belongs to the box's own hit-test layer).
      // Invisible (and click-through) until the first painted frame: the
      // box exists for the whole engine boot, and an empty theme-colored
      // rectangle over the textarea reads as a white flash. Revealed in the
      // ready chain below once real grid pixels are on the canvas.
      box.style.cssText =
        'position:fixed;z-index:2147483646;box-sizing:border-box;' +
        'background:' + bgCss + ';overflow:hidden;padding:0;margin:0;' +
        'opacity:0;pointer-events:none;';
      // Replicate the textarea's box styling so the overlay is a visual
      // stand-in, not a floating panel: padding and border (the canvas fills
      // the CONTENT box, so the grid is inset exactly like the textarea's
      // text), border radius, and resizability (resize needs
      // overflow!=visible, set above; dragging the handle writes inline
      // width/height on the box and the observer below pushes that onto the
      // textarea).
      const taStyle = getComputedStyle(ta);
      const COPY_PROPS = [
        'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
        'border-top-width', 'border-top-style', 'border-top-color',
        'border-right-width', 'border-right-style', 'border-right-color',
        'border-bottom-width', 'border-bottom-style', 'border-bottom-color',
        'border-left-width', 'border-left-style', 'border-left-color',
        'border-top-left-radius', 'border-top-right-radius',
        'border-bottom-right-radius', 'border-bottom-left-radius',
      ];
      for (let i = 0; i < COPY_PROPS.length; i++) {
        box.style.setProperty(COPY_PROPS[i], taStyle.getPropertyValue(COPY_PROPS[i]));
      }
      box.style.resize = taStyle.resize || 'none';
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'display:block;width:100%;height:100%;outline:none;';
      box.appendChild(canvas);

      // SIZE CONTRACT: overlay == textarea. reposition() sizes the box to
      // the textarea's border-box rect (floored/viewport-clamped) and pins it
      // over it; it re-runs on scroll/resize and whenever the TEXTAREA's
      // size changes (page scripts, our own propagation below). `lastSet`
      // remembers what reposition wrote so boxRO can tell a user drag from
      // a programmatic write. The canvas fills the box, so mount_into's own
      // ResizeObserver reflows the grid on any box size change.
      const lastSet = { w: -1, h: -1 };
      function reposition(): void {
        const r = ta.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const bw = Math.min(Math.max(r.width, MIN_W), vw - 2 * MARGIN);
        const bh = Math.min(Math.max(r.height, MIN_H), vh - 2 * MARGIN);
        const left = Math.max(MARGIN, Math.min(r.left, vw - bw - MARGIN));
        const top = Math.max(MARGIN, Math.min(r.top, vh - bh - MARGIN));
        box.style.left = left + 'px';
        box.style.top = top + 'px';
        if (Math.abs(bw - lastSet.w) >= 1 || Math.abs(bh - lastSet.h) >= 1) {
          lastSet.w = bw; lastSet.h = bh;
          box.style.width = bw + 'px';
          box.style.height = bh + 'px';
        }
      }
      reposition();
      document.body.appendChild(box);
      window.addEventListener('scroll', reposition, true);
      window.addEventListener('resize', reposition);

      // Box size changed away from what reposition wrote => the user dragged
      // the resize handle (or a script resized us): push the new size onto
      // the textarea. Its own observer then re-runs reposition, which
      // converges (sizes equal -> no further writes).
      const boxRO = new ResizeObserver(function () {
        const r = box.getBoundingClientRect();
        if (!(r.width > 0) || !(r.height > 0)) { return; }
        if (Math.abs(r.width - lastSet.w) < 1 && Math.abs(r.height - lastSet.h) < 1) { return; }
        lastSet.w = r.width; lastSet.h = r.height;
        setTextareaSize(ta, r.width, r.height);
      });
      boxRO.observe(box);
      const taRO = new ResizeObserver(function () { reposition(); });
      taRO.observe(ta);

      // Keep bubbling keys/clicks inside the overlay: without this, keydowns
      // that mount_into forwards to nvim ALSO bubble to the page's document-
      // level hotkey handlers (GitHub-style single-key shortcuts).
      function stopper(e: Event): void { e.stopPropagation(); }
      canvas.addEventListener('keydown', stopper);
      canvas.addEventListener('keyup', stopper);
      canvas.addEventListener('keypress', stopper);

      // ---- transport: Port <-> neovim.js Transport --------------------------
      const port = chrome.runtime.connect({ name: NvimExt.PORT_NAME });
      const transport: any = {
        onMessage: null,
        onClose: null,
        onStatus: null,
        send: function (u8: Uint8Array) {
          try { port.postMessage({ t: 'rpc', b: NvimExt.b64FromBytes(u8) }); }
          catch (_e) { /* port dead; onDisconnect ends the session */ }
        },
        close: function () { try { port.disconnect(); } catch (_e) {} },
      };
      port.onMessage.addListener(function (m: any) {
        if (!m) { return; }
        if (m.t === 'rpc') {
          if (transport.onMessage) { transport.onMessage(NvimExt.bytesFromB64(m.b)); }
        } else if (m.t === 'status' && m.s) {
          // Engine 'exit' maps to the transport-closed seam (like
          // browserEngineTransport); everything else is a status.
          if (m.s.kind === 'exit') { if (transport.onClose) { transport.onClose(); } }
          else if (transport.onStatus) { transport.onStatus(m.s); }
        }
      });
      port.onDisconnect.addListener(function () {
        if (transport.onClose) { transport.onClose(); }
      });

      // ---- the standard library stack over that transport -------------------
      const nvim = Neovim.createNvim({
        transport: transport,
        MessagePack: (globalThis as any).MessagePack,
      });
      // The UI is mounted LATE, after the session Lua has themed the engine
      // (see the ready chain below) -- mounting attaches the UI, and the
      // engine's first redraw would otherwise carry nvim's default DARK
      // colorscheme (the theme exec_lua hasn't run yet), flashing a black
      // grid before the real colors land. Until mount the canvas is
      // transparent over the theme-colored box, so nothing unthemed ever
      // paints. Buffer load + exec_lua need no attached UI.
      let ui: any = null;

      let done = false;
      function teardown(): void {
        if (done) { return; }
        done = true;
        sessions.delete(ta);
        try { if (ui) { ui.dispose(); } } catch (_e) {}
        try { nvim.dispose(); } catch (_e) {}
        boxRO.disconnect();
        taRO.disconnect();
        window.removeEventListener('scroll', reposition, true);
        window.removeEventListener('resize', reposition);
        box.remove();
        try { ta.focus(); } catch (_e) {}
      }

      // `:w` (and the write half of :wq/:x) pushes the buffer back here.
      nvim.onNotification('nvim_textarea_write', function (params: any) {
        const lines = params && params[0];
        if (Array.isArray(lines)) { setTextareaValue(ta, lines.join('\n')); }
      });

      // Engine exit (`:q`, `:wq`, ZZ, a crash) or a dropped port ends the
      // session. createNvim turns the transport-closed seam into a
      // {kind:'exit'} status and rejects in-flight requests.
      nvim.onStatus(function (s: any) {
        if (!s) { return; }
        if (s.kind === 'exit') { teardown(); }
        else if (s.kind === 'error') { console.error('[nvim-textarea] engine error:', s.error); }
      });

      // ---- load the textarea into the buffer --------------------------------
      const lines = String(ta.value == null ? '' : ta.value).split('\n');
      nvim.ready
        .then(function () { return nvim.request('nvim_buf_set_lines', [0, 0, -1, false, lines]); })
        .then(function () {
          return nvim.request('nvim_exec_lua', [SESSION_LUA,
            [nvim.chan, bufferName(ta), theme.fg, theme.bg, theme.light ? 'light' : 'dark']]);
        })
        .then(function () {
          return Neovim.enableClipboard(nvim, Neovim.browserClipboardProvider()).catch(function (e: any) {
            console.warn('[nvim-textarea] clipboard wiring failed:', e && e.message || e);
          });
        })
        .then(function () {
          if (done) { return; }
          // The engine is themed; NOW attach the UI. The grid renders one
          // glyph per fixed-advance cell, so it needs a monospace font;
          // heuristic: adopt the textarea's own stack only when it smells
          // monospace (a fallback naming mono/courier/consolas/menlo/monaco
          // -- if one entry is monospace the rest are too), else use a
          // standard monospace stack. The SIZE is copied either way.
          const MONO_STACK = 'ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace';
          const taFont = taStyle.fontFamily || '';
          // Reveal on the first redraw AFTER attach: painting happens
          // synchronously when the redraw's flush decodes (mount_into's
          // immediate-paint path), so by this macrotask the grid pixels are
          // already on the canvas -- no empty-box frame can show.
          const offReveal = nvim.onNotification('redraw', function () {
            offReveal();
            setTimeout(function () {
              box.style.opacity = '';
              box.style.pointerEvents = '';
            }, 0);
          });
          ui = NeovimUI.mount_into(nvim, canvas, {
            font_family: /mono|courier|consol|menlo|monaco/i.test(taFont) ? taFont : MONO_STACK,
            font_size: parseFloat(taStyle.fontSize) || 13,
            default_fg: theme.fg,
            default_bg: theme.bg,
          });
          box.setAttribute('data-nvim-ready', '');
        })
        .catch(function (err: any) {
          console.error('[nvim-textarea] session setup failed:', err && err.message || err);
          teardown();
        });

      sessions.set(ta, { focus: function () { canvas.focus(); } });
    }

    w.__nvimOverlay = { open: open };
  }

  // First injection: open on the target the trigger recorded.
  const pending = w.__nvimPendingTarget;
  w.__nvimPendingTarget = null;
  if (pending) { w.__nvimOverlay.open(pending); }
})();
