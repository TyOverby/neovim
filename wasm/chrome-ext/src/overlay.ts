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

    const MIN_W = 480, MIN_H = 240, MARGIN = 8;

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

    // navigator.clipboard-backed provider for Neovim.enableClipboard (the
    // library's built-in 'browser' provider is create()-only; this is the same
    // idea, minus the regtype cache). Failures surface as RPC errors/warnings
    // at use time -- clipboard is a nicety, not a session requirement.
    function clipboardProvider(): any {
      return {
        get: function () {
          if (!navigator.clipboard || !navigator.clipboard.readText) {
            return Promise.reject(new Error('clipboard unavailable'));
          }
          return navigator.clipboard.readText();
        },
        set: function (lines: any) {
          const text = Array.isArray(lines) ? lines.join('\n') : String(lines == null ? '' : lines);
          if (!navigator.clipboard || !navigator.clipboard.writeText) { return Promise.resolve(); }
          return navigator.clipboard.writeText(text).catch(function (e: any) {
            console.warn('[nvim-textarea] clipboard write failed:', e && e.message || e);
          });
        },
      };
    }

    function open(ta: HTMLTextAreaElement): void {
      const existing = sessions.get(ta);
      if (existing) { existing.focus(); return; }

      // ---- overlay DOM ----------------------------------------------------
      const box = document.createElement('div');
      // Page-observable markers (the content-script world itself is invisible
      // to the page): present = session open, data-nvim-ready = buffer loaded
      // and writable. The e2e drives the extension through these.
      box.setAttribute('data-nvim-overlay', '');
      box.style.cssText =
        'position:fixed;z-index:2147483646;box-sizing:border-box;' +
        'background:#000;border:1px solid #555;border-radius:4px;' +
        'box-shadow:0 4px 24px rgba(0,0,0,0.5);overflow:hidden;padding:0;margin:0;';
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'display:block;width:100%;height:100%;outline:none;';
      box.appendChild(canvas);

      // Cover the textarea, with a floor so tiny textareas still yield a
      // usable grid, clamped into the viewport. Re-run on scroll/resize (the
      // canvas is position:fixed, so ancestor scrolling moves the textarea
      // out from under it otherwise). mount_into's ResizeObserver picks up
      // any size change and reflows the grid.
      function reposition(): void {
        const r = ta.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const bw = Math.min(Math.max(r.width, MIN_W), vw - 2 * MARGIN);
        const bh = Math.min(Math.max(r.height, MIN_H), vh - 2 * MARGIN);
        const left = Math.max(MARGIN, Math.min(r.left, vw - bw - MARGIN));
        const top = Math.max(MARGIN, Math.min(r.top, vh - bh - MARGIN));
        box.style.left = left + 'px';
        box.style.top = top + 'px';
        box.style.width = bw + 'px';
        box.style.height = bh + 'px';
      }
      reposition();
      document.body.appendChild(box);
      window.addEventListener('scroll', reposition, true);
      window.addEventListener('resize', reposition);

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
          return Neovim.enableClipboard(nvim, clipboardProvider()).catch(function (e: any) {
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
