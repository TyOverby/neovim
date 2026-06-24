// Spike B — the fail-fast + reconnect state machine, driving the REAL
// wasm/proxy-client.js (no mocks of the client itself). De-risks the central
// claim of the reconnection design: when the transport drops, every
// JSPI-suspended syscall promise must REJECT promptly so the syscall returns an
// errno (-EIO) instead of hanging the engine — and a fresh transport must let
// subsequent ops succeed, with the editor state (in the browser) untouched.
//
// We model three real pieces:
//   1. proxy-client.js as-is (its pending map + onTransportClosed()).
//   2. The syscall override's rejection arm: `req.then(ok, () => -5 /*EIO*/)`,
//      exactly the shape in nvim_fs_proxy.js fd_read/fd_write.
//   3. A ReconnectingProxy wrapper (the NEW engine-worker piece): on transport
//      close it calls onTransportClosed() to fail in-flight ops, then dials a
//      fresh transport+client so the next op succeeds.
'use strict';

const path = require('path');
const { createProxyClient } = require(
  require('path').resolve(__dirname, '../../proxy-client.js'));

let pass = 0, failN = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { failN++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A killable in-memory transport pair. The "server" answers `echo` only for
// requests received while live; killing it strands anything in flight (exactly
// what a dropped WebSocket does to suspended syscalls).
function makeLink({ autoAnswer = true } = {}) {
  let onFrameToServer = null;
  let alive = true;
  const ProxyClient = require(require('path').resolve(__dirname, '../../proxy-client.js'));
  const transport = {
    send(data) {
      if (!alive) { throw new Error('transport dead'); }
      if (!autoAnswer) { return; } // stranded: never answers (the "slow op" case)
      // Decode the request and answer it asynchronously, like a real server.
      const { header } = ProxyClient.decodeFrame(data);
      if (header.t === 'req' || header.t === 'hello') {
        setTimeout(() => {
          if (!alive) { return; }
          transport.onFrame(ProxyClient.encodeFrame({
            t: 'res', id: header.id, ok: true,
            result: { echoed: header.method || 'hello' },
          }));
        }, 5);
      }
    },
    close() { alive = false; },
  };
  return {
    transport,
    kill() { alive = false; }, // simulate ws.onclose with no clean shutdown
  };
}

// The syscall override pattern, verbatim shape from nvim_fs_proxy.js:
//   return proxy.request(...).then(onResolve, () => -5 /* -EIO */);
// Returns a promise that NEVER rejects — it resolves to an errno on failure,
// which is what keeps the suspended __async syscall from becoming an unhandled
// rejection / engine abort.
function syscallLikeRead(client) {
  return client.request('fs.read', { len: 16 }).then(
    () => 0,            // success: 0
    () => -5);          // failure: -EIO, NEVER throws
}

async function test_failFast_noHang() {
  const link = makeLink({ autoAnswer: false }); // requests will be stranded
  const client = createProxyClient(link.transport);

  // Fire a burst of "syscalls" that suspend awaiting responses that never come.
  const N = 25;
  const inflight = [];
  for (let i = 0; i < N; i++) { inflight.push(syscallLikeRead(client)); }

  await sleep(20); // let them all be pending

  // Transport drops. The engine-worker's ws.onclose must call this.
  const t0 = Date.now();
  client.onTransportClosed();

  // Every suspended syscall must settle to -EIO, promptly, with NO hang.
  const settled = await Promise.race([
    Promise.all(inflight),
    sleep(1000).then(() => 'TIMEOUT'),
  ]);
  const elapsed = Date.now() - t0;

  check('all in-flight syscalls settle on disconnect (no hang)',
    settled !== 'TIMEOUT', 'timed out — engine would wedge');
  check('every stranded syscall returns -EIO (not a thrown rejection)',
    Array.isArray(settled) && settled.length === N && settled.every((v) => v === -5),
    Array.isArray(settled) ? 'values=' + JSON.stringify([...new Set(settled)]) : 'n/a');
  check('disconnect fan-out is prompt (<100ms for 25 ops)', elapsed < 100, elapsed + 'ms');
}

async function test_newRequestsAfterCloseFailCleanly() {
  // DESIGN FINDING from the first run: onTransportClosed() rejects in-flight
  // requests but does NOT set `closed`, so a NEW request issued during the
  // outage window (drop happened, reconnect not yet complete) against that
  // stale client would HANG. The reconnecting wrapper must therefore call
  // client.close() on drop (rejects in-flight AND future requests) and route
  // new syscalls to a fresh client. Here we verify close() gives fail-fast for
  // requests issued during the outage.
  const link = makeLink({ autoAnswer: false });
  const client = createProxyClient(link.transport);
  client.close();
  // A syscall issued AFTER close() must reject immediately -> -EIO, no hang.
  const v = await Promise.race([syscallLikeRead(client), sleep(500).then(() => 'HANG')]);
  check('syscall issued during outage returns -EIO (close, not just onTransportClosed)',
    v === -5, 'got ' + v);
}

// The NEW engine-worker piece: a reconnecting wrapper. It owns the current
// client, fails in-flight ops on drop, and re-dials. The syscall overrides call
// proxy().request(...) — proxy() always returns the *current live* client.
async function test_reconnect_restoresService() {
  // A dial() that returns live links; we keep a handle to trigger drop+reconnect.
  const links = [];
  const dial = () => {
    const link = makeLink({ autoAnswer: true });
    links.push(link);
    return link;
  };
  let client = null, generation = 0, currentLink = null;
  function connect() {
    currentLink = dial();
    const myClient = createProxyClient(currentLink.transport); // capture THIS conn's client
    client = myClient;
    const myGen = ++generation;
    currentLink.onClose = () => {
      if (myGen !== generation) { return; }
      myClient.close();  // fail in-flight + reject any future req to the stale client
      connect();         // immediate re-dial for the spike (backoff in real life)
    };
  }
  connect();

  // Works before the drop.
  const before = await syscallLikeRead(client);
  check('syscall succeeds before drop', before === 0, 'got ' + before);

  // Start an op, drop mid-flight: it must fail -EIO.
  const stranded = syscallLikeRead(client);
  currentLink.kill();
  currentLink.onClose();                 // ws.onclose fires -> fail-fast + reconnect
  const strandedResult = await stranded;
  check('op in flight at drop returns -EIO', strandedResult === -5, 'got ' + strandedResult);

  // After reconnect, NEW ops succeed against the fresh client.
  await sleep(10);
  const after = await syscallLikeRead(client);
  check('syscall succeeds after automatic reconnect', after === 0, 'got ' + after);
  check('reconnect created a fresh transport', links.length === 2, links.length + ' links dialed');
}

(async () => {
  await test_failFast_noHang();
  await test_newRequestsAfterCloseFailCleanly();
  await test_reconnect_restoresService();
  console.log('\nspike B: ' + pass + ' passed, ' + failN + ' failed');
  process.exit(failN ? 1 : 0);
})();
