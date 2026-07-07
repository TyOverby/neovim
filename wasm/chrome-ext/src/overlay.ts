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

    // Buffer-side session setup, run once the instance is ready:
    //   * name the buffer and make it write-through: 'acwrite' + a BufWriteCmd
    //     that rpcnotify()s the full buffer back to us (`:w` and the write half
    //     of `:wq`/`:x` both land here), then marks the buffer unmodified so
    //     the quit half proceeds without E37.
    //   * soft-wrap long lines, textarea-style.
    const SESSION_LUA = [
      'local chan, name = ...',
      'local buf = vim.api.nvim_get_current_buf()',
      'pcall(vim.api.nvim_buf_set_name, buf, name)',
      "vim.bo[buf].buftype = 'acwrite'",
      'vim.bo[buf].swapfile = false',
      'vim.wo.wrap = true',
      'vim.wo.linebreak = true',
      "vim.api.nvim_create_autocmd('BufWriteCmd', {",
      '  buffer = buf,',
      '  callback = function()',
      "    vim.rpcnotify(chan, 'nvim_textarea_write', vim.api.nvim_buf_get_lines(buf, 0, -1, false))",
      '    vim.bo[buf].modified = false',
      '  end,',
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
      // The box shrink-wraps the canvas (auto size); the CANVAS carries the
      // explicit pixel size and, when the textarea is resizable, the native
      // resize handle -- putting the handle on the canvas itself keeps it on
      // top (a handle on the box would be covered by the canvas).
      box.style.cssText =
        'position:fixed;z-index:2147483646;box-sizing:border-box;' +
        'background:#000;border:1px solid #555;border-radius:4px;' +
        'box-shadow:0 4px 24px rgba(0,0,0,0.5);overflow:hidden;padding:0;margin:0;';
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'display:block;outline:none;overflow:hidden;';
      // Mirror the textarea's resizability (resize needs overflow!=visible,
      // set above). Dragging the handle writes inline width/height on the
      // canvas; the observer below pushes that onto the textarea.
      canvas.style.resize = getComputedStyle(ta).resize || 'none';
      box.appendChild(canvas);

      // SIZE CONTRACT: overlay == textarea. reposition() sizes the canvas to
      // the textarea's border-box rect (floored/viewport-clamped) and pins the
      // box over it; it re-runs on scroll/resize and whenever the TEXTAREA's
      // size changes (page scripts, our own propagation below). `lastSet`
      // remembers what reposition wrote so canvasRO can tell a user drag from
      // a programmatic write. mount_into's own ResizeObserver reflows the grid
      // on any canvas size change.
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
          canvas.style.width = bw + 'px';
          canvas.style.height = bh + 'px';
        }
      }
      reposition();
      document.body.appendChild(box);
      window.addEventListener('scroll', reposition, true);
      window.addEventListener('resize', reposition);

      // Canvas size changed away from what reposition wrote => the user
      // dragged the resize handle (or a script resized us): push the new size
      // onto the textarea. Its own observer then re-runs reposition, which
      // converges (sizes equal -> no further writes).
      const canvasRO = new ResizeObserver(function () {
        const r = canvas.getBoundingClientRect();
        if (!(r.width > 0) || !(r.height > 0)) { return; }
        if (Math.abs(r.width - lastSet.w) < 1 && Math.abs(r.height - lastSet.h) < 1) { return; }
        lastSet.w = r.width; lastSet.h = r.height;
        setTextareaSize(ta, r.width, r.height);
      });
      canvasRO.observe(canvas);
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
      const ui = NeovimUI.mount_into(nvim, canvas, {
        font_family: 'ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace',
        font_size: 13,
      });

      let done = false;
      function teardown(): void {
        if (done) { return; }
        done = true;
        sessions.delete(ta);
        try { ui.dispose(); } catch (_e) {}
        try { nvim.dispose(); } catch (_e) {}
        canvasRO.disconnect();
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
        .then(function () { return nvim.request('nvim_exec_lua', [SESSION_LUA, [nvim.chan, bufferName(ta)]]); })
        .then(function () {
          return Neovim.enableClipboard(nvim, Neovim.browserClipboardProvider()).catch(function (e: any) {
            console.warn('[nvim-textarea] clipboard wiring failed:', e && e.message || e);
          });
        })
        .then(function () { box.setAttribute('data-nvim-ready', ''); })
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
