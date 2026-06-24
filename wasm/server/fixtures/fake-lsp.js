#!/usr/bin/env node
// wasm/server/fixtures/fake-lsp.js - a tiny, dependency-free language server that
// speaks LSP over stdio. Used by wasm/web/lsp-proxy.test.js to prove that a real
// LSP client running on the wasm engine can spawn + handshake + round-trip a
// request with a server process that runs (for real) on the IO-proxy SERVER.
//
// It is NOT a real language server -- it implements just enough of the protocol:
//   - reads Content-Length-framed JSON-RPC messages from stdin;
//   - replies to `initialize` with a capabilities result (hoverProvider on);
//   - accepts the `initialized` notification;
//   - replies to `textDocument/hover` with a fixed hover result (the round-trip
//     the test asserts);
//   - replies to `shutdown` with null and exits 0 on the `exit` notification.
//
// Everything is stdio: no network, no deps. The server (wasm/server/proc-handlers.js)
// spawns it as `{'node', <abs path to this file on the server>}`.
'use strict';

let buf = Buffer.alloc(0);

function send(msg) {
  const json = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.from('Content-Length: ' + json.length + '\r\n\r\n', 'ascii');
  process.stdout.write(Buffer.concat([header, json]));
}

function handle(msg) {
  // Requests have an `id`; notifications do not.
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        capabilities: {
          // A textDocumentSync + hoverProvider is enough for vim.lsp to treat the
          // server as initialized and to allow a hover request.
          textDocumentSync: 1,
          hoverProvider: true,
        },
        serverInfo: { name: 'fake-lsp', version: '0.0.1' },
      },
    });
    return;
  }
  if (msg.method === 'initialized') {
    // notification: nothing to reply.
    return;
  }
  if (msg.method === 'textDocument/hover') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        contents: { kind: 'plaintext', value: 'HOVER_FROM_FAKE_LSP' },
      },
    });
    return;
  }
  if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
    return;
  }
  if (msg.method === 'exit') {
    process.exit(0);
  }
  // Any other request: reply with a null result so the client never hangs.
  if (typeof msg.id !== 'undefined' && msg.id !== null) {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
  }
}

// Parse the Content-Length framing off the incoming byte stream.
function pump() {
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) { return; }
    const header = buf.slice(0, sep).toString('ascii');
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) {
      // Malformed header: drop up to the separator and continue.
      buf = buf.slice(sep + 4);
      continue;
    }
    const len = parseInt(m[1], 10);
    const start = sep + 4;
    if (buf.length < start + len) { return; }  // wait for the full body
    const body = buf.slice(start, start + len).toString('utf8');
    buf = buf.slice(start + len);
    let msg;
    try { msg = JSON.parse(body); } catch (e) { continue; }
    try { handle(msg); } catch (e) { /* keep the server alive */ }
  }
}

process.stdin.on('data', function (chunk) {
  buf = Buffer.concat([buf, chunk]);
  pump();
});
process.stdin.on('end', function () { process.exit(0); });
// A stray error on stdout (e.g. the client closed) shouldn't crash noisily.
process.stdout.on('error', function () { process.exit(0); });
