// wasm/web/neovim-utils.js - high-level helpers over a neovim.js instance.
//
// The "utilities" layer (see wasm/README.md). These are NOT instance methods:
// the core instance surface (request/notify/input/onNotification/onStatus/
// onRequest/chan/ready) stays exactly as neovim.js defines it. The helpers here
// are FREE FUNCTIONS that take the instance as their first argument and build
// only on that public surface (mostly `request` + `onNotification` + `chan`).
//
// They collapse the common embedding chores -- open a file, read/write the
// engine's in-memory FS (which the JS client can't touch directly), register
// autocmds, and the rpcnotify round-trip ("tell me when the user saves") -- into
// single calls. Everything is plain msgpack-RPC over the instance, so the exact
// same code runs in the browser and under the Node e2e harness.
//
// UMD: usable as a <script> (globalThis.NeovimUtils) or via require() in Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.NeovimUtils = factory(); }
})(typeof self !== 'undefined' ? self
   : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- file helpers -------------------------------------------------------

  // open_file_in_editor(instance, path) -> Promise
  //   Open `path` in the current window (like `:edit path`). We use nvim_cmd with
  //   a structured command so the path needs no manual `:edit` escaping. Resolves
  //   when the edit completes; rejects if nvim_cmd errors.
  function open_file_in_editor(instance, path) {
    return instance.request('nvim_cmd', [{ cmd: 'edit', args: [String(path)] }, {}]);
  }

  // read_file(instance, path) -> Promise<string | null>
  //   Read `path` from the ENGINE's in-memory filesystem (the browser JS client
  //   has no direct access to it) and return its contents as one string, lines
  //   joined by '\n'. Resolves to `null` if the file does not exist or is not
  //   readable -- callers test for null rather than catching a reject. (A genuine
  //   Lua/RPC error still rejects.)
  function read_file(instance, path) {
    var lua =
      'local p = ...\n' +
      'if vim.fn.filereadable(p) == 0 then return nil end\n' +
      'return table.concat(vim.fn.readfile(p), "\\n")\n';
    return instance.request('nvim_exec_lua', [lua, [String(path)]]);
  }

  // write_file(instance, path, content) -> Promise
  //   Write `content` (a string) to `path` in the engine FS, creating missing
  //   parent directories. Splits on '\n' so each line is written as a FS line
  //   (writefile does not append a trailing newline beyond the line list, matching
  //   vim's own :write semantics). Resolves when the write completes; rejects on a
  //   Lua/RPC error (e.g. an unwritable path).
  function write_file(instance, path, content) {
    var lua =
      'local p, c = ...\n' +
      'vim.fn.mkdir(vim.fn.fnamemodify(p, ":h"), "p")\n' +
      'return vim.fn.writefile(vim.split(c, "\\n"), p)\n';
    return instance.request('nvim_exec_lua', [lua, [String(path), String(content)]]);
  }

  // ---- autocmd + rpcnotify helpers ----------------------------------------

  // create_autocmd(instance, events, opts) -> Promise<number>
  //   Thin wrapper over nvim_create_autocmd: `events` (string or array) and `opts`
  //   (pattern/group/command/callback/...) are passed straight through. Resolves
  //   to the new autocmd id.
  function create_autocmd(instance, events, opts) {
    return instance.request('nvim_create_autocmd', [events, opts || {}]);
  }

  // add_notify_handler(instance, name, fn) -> unsubscribe()
  //   Sugar over instance.onNotification(name, fn): subscribe `fn` to RPC
  //   notifications named `name` (the receiving half of the rpcnotify pattern).
  //   `fn` receives the notification's params array. Returns the unsubscribe fn.
  function add_notify_handler(instance, name, fn) {
    return instance.onNotification(name, fn);
  }

  // A per-instance counter so concurrent on_autocmd() calls get distinct
  // notification names / augroups even with identical events.
  var _seq = 0;

  // on_autocmd(instance, events, opts, fn) -> Promise<handle>
  //   The combined convenience: create a dedicated augroup + an autocmd whose
  //   action calls rpcnotify(instance.chan, <generated-name>, expand('<afile>:p'),
  //   bufnr('%')) back at this client, AND register `fn` for that notification --
  //   so a single call wires the whole "notify me on <event>" round-trip.
  //
  //   `events` is a string or array (e.g. 'BufWritePost' or ['BufWritePost']).
  //   `opts` is optional and merged into the nvim_create_autocmd opts; use it to
  //   set `pattern` (default '*'). A caller-supplied `command`/`callback`/`group`
  //   is ignored here -- this helper owns the action and the group.
  //
  //   `fn` is invoked as fn(payload) where `payload` is:
  //       { file: <string>,   // absolute path of the file the event fired for
  //                           //   (expand('<afile>:p'); '' when not applicable)
  //         buffer: <number>, // the current buffer number (bufnr('%'))
  //         event: <events>,  // the `events` argument, as passed in
  //         params: <array> } // the raw rpcnotify params: [file, buffer]
  //
  //   Returns a Promise of a handle { id, group, name, unsubscribe() }:
  //     id          - the autocmd id (also usable with nvim_del_autocmd)
  //     group       - the augroup id
  //     name        - the generated notification name
  //     unsubscribe - removes the notification handler AND deletes the augroup
  //                   (so the engine stops firing the rpcnotify).
  //
  //   Must be called after the instance is ready (instance.chan is set); if chan
  //   is not yet available it awaits instance.ready, then guards that chan exists.
  function on_autocmd(instance, events, opts, fn) {
    opts = opts || {};
    var ready = (instance.chan != null) ? Promise.resolve()
      : (instance.ready ? Promise.resolve(instance.ready) : Promise.resolve());
    return ready.then(function () {
      if (instance.chan == null) {
        throw new Error('on_autocmd: instance has no RPC channel yet (await instance.ready)');
      }
      var n = ++_seq;
      var name = '__nvim_utils_autocmd_' + n;
      var groupName = '__NvimUtils_' + n;

      // Receiving half: register fn for the generated notification first, so we
      // never miss an event fired between create and subscribe.
      var off = instance.onNotification(name, function (params) {
        params = params || [];
        fn({
          file: params[0],
          buffer: params[1],
          event: events,
          params: params,
        });
      });

      // Sending half: an augroup + an autocmd whose command rpcnotify()s us. The
      // augroup (clear=true) makes the handle's teardown a single nvim_del_augroup.
      return instance.request('nvim_create_augroup', [groupName, { clear: true }])
        .then(function (group) {
          var autoOpts = Object.assign({}, opts);
          if (autoOpts.pattern == null) { autoOpts.pattern = '*'; }
          delete autoOpts.callback;   // we own the action
          autoOpts.group = group;
          autoOpts.command =
            "call rpcnotify(" + instance.chan + ", '" + name +
            "', expand('<afile>:p'), bufnr('%'))";
          return instance.request('nvim_create_autocmd', [events, autoOpts])
            .then(function (id) {
              var disposed = false;
              return {
                id: id,
                group: group,
                name: name,
                unsubscribe: function () {
                  if (disposed) { return Promise.resolve(); }
                  disposed = true;
                  off();
                  return instance.request('nvim_del_augroup_by_id', [group])
                    .catch(function () { /* engine may be gone; ignore */ });
                },
              };
            });
        })
        .catch(function (e) { off(); throw e; });
    });
  }

  return {
    open_file_in_editor: open_file_in_editor,
    read_file: read_file,
    write_file: write_file,
    create_autocmd: create_autocmd,
    add_notify_handler: add_notify_handler,
    on_autocmd: on_autocmd,
  };
});
