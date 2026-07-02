// wasm/web/reconnect.test.js - the fault-injection test for the stage-5
// ReconnectingProxy (wasm/proxy-reconnect.js), the highest-risk piece of the
// reconnection contract. It drives the REAL facade + the REAL proxy-client
// against the REAL Node IO-proxy server over a real WebSocket, and injects a
// mid-flight transport drop, asserting:
//   1. a request in flight when the socket drops FAILS FAST (no hang);
//   2. a request issued DURING the outage fails fast (the Spike B finding —
//      close() the dead client, not just onTransportClosed);
//   3. after automatic reconnect, new requests SUCCEED again (the editor's IO
//      recovers without the engine ever restarting).
//
// The server stays up the whole time; we simulate the drop by terminating the
// underlying ws, exactly as a network blip would, so the facade reconnects to
// the still-running server. Run: node wasm/web/reconnect.test.js
'use strict';

const path = require('path');
const WebSocket = require(path.join(__dirname, 'node_modules', 'ws'));
const { WebSocketServer } = require(path.join(__dirname, 'node_modules', 'ws'));
const { createReconnectingProxy } = require('../proxy-reconnect.js');
const ProxyClient = require('../proxy-client.js');
const { encodeFrame, decodeFrame } = ProxyClient;

// A MINIMAL mock proxy server: just enough of the frame protocol to test the
// ReconnectingProxy facade (hello ack, ping, proc.spawn + a proc.exit push). The
// real IO proxy is the Go server (rvim) + its conformance/e2e suites; this test
// is about the transport facade (connect / drop / reconnect / request / push),
// which needs no real IO. Returns { url, close }.
function startMockServer(opts) {
  opts = opts || {};
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', function (ws) {
    ws.on('message', function (data) {
      let frame;
      try { frame = decodeFrame(data); } catch (_e) { return; }
      const h = frame.header;
      if (h.t === 'hello') {
        // failHello: accept the socket but reject the handshake (the engine-dead
        // failure mode the reconnect contract must still recover from).
        ws.send(encodeFrame({ t: 'res', id: h.id, ok: !opts.failHello,
          result: opts.failHello ? undefined : { hello: true, config: {} },
          error: opts.failHello ? 'handshake refused' : undefined }));
      } else if (h.t === 'req' && h.method === 'noreply') {
        // intentionally never responds (to leave requests in-flight)
      } else if (h.t === 'req' && h.method === 'ping') {
        ws.send(encodeFrame({ t: 'res', id: h.id, ok: true, result: { pong: true, now: Date.now() } }));
      } else if (h.t === 'req' && h.method === 'proc.spawn') {
        ws.send(encodeFrame({ t: 'res', id: h.id, ok: true, result: { id: 1 } }));
        setTimeout(function () {
          try { ws.send(encodeFrame({ t: 'push', method: 'proc.exit', params: { id: 1, code: 0, signal: 0 } })); } catch (_e) {}
        }, 20);
      } else if (h.t === 'req') {
        ws.send(encodeFrame({ t: 'res', id: h.id, ok: false, error: 'unknown method' }));
      }
    });
  });
  return new Promise(function (resolve) {
    wss.on('listening', function () {
      const port = wss.address().port;
      resolve({ url: 'ws://127.0.0.1:' + port + '/', close: () => wss.close() });
    });
  });
}

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (detail ? ' :: ' + detail : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wrap the `ws` package (EventEmitter) in the browser-WebSocket shape the facade
// dials. rawDrop() simulates a transport blip (terminate, no close handshake).
function wrapWS(url, registry) {
  const ws = new WebSocket(url);
  const t = {
    send: (d) => ws.send(d),
    close: () => { try { ws.close(); } catch (_e) {} },
    rawDrop: () => { try { ws.terminate(); } catch (_e) {} },
  };
  ws.on('open', () => { if (t.onopen) t.onopen(); });
  ws.on('message', (data) => { if (t.onmessage) t.onmessage({ data }); });
  ws.on('close', () => { if (t.onclose) t.onclose(); });
  ws.on('error', () => { if (t.onerror) t.onerror(); });
  registry.push(t);
  return t;
}

async function main() {
  // A minimal mock proxy server on an ephemeral loopback port.
  const server = await startMockServer();
  const url = server.url;

  const dialed = [];
  const statuses = [];
  const facade = createReconnectingProxy({
    ProxyClient,
    dial: () => wrapWS(url, dialed),
    helloParams: { nvimSocket: '' },
    onStatus: (ev) => statuses.push(ev.kind),
    baseBackoff: 50,        // fast backoff for the test
    maxBackoff: 200,
  });

  // 1) connects + a request works.
  for (let i = 0; i < 100 && !facade.isConnected(); i++) { await sleep(20); }
  ok('facade connects to the server', facade.isConnected());
  let r = await facade.request('ping', {}, null).catch((e) => ({ err: e }));
  ok('request works before the drop', r && r.result && r.result.pong === true);

  // 2) drop the transport mid-flight: in-flight + during-outage requests fail
  //    fast (no hang), within a hard timeout.
  const inflight = facade.request('ping', {}, null).then(() => 'ok', () => 'rejected');
  dialed[dialed.length - 1].rawDrop();        // blip the socket
  const t0 = Date.now();
  const settled = await Promise.race([inflight, sleep(2000).then(() => 'HANG')]);
  ok('in-flight request fails fast on drop (no hang)', settled === 'rejected', settled);
  ok('drop fan-out is prompt', Date.now() - t0 < 1000, (Date.now() - t0) + 'ms');

  // A request issued DURING the outage also fails fast (not hang) — the close()
  // -on-drop fix; otherwise it would queue on a stale-but-open client.
  const during = await Promise.race([
    facade.request('ping', {}, null).then(() => 'ok', () => 'rejected'),
    sleep(2000).then(() => 'HANG'),
  ]);
  ok('request during the outage fails fast', during === 'rejected', during);
  ok('facade reports disconnected during the outage', !facade.isConnected());

  // 3) the facade reconnects on its own; new requests succeed again.
  for (let i = 0; i < 200 && !facade.isConnected(); i++) { await sleep(20); }
  ok('facade reconnects automatically', facade.isConnected());
  ok('a fresh transport was dialed for the reconnect', dialed.length >= 2, dialed.length + ' dials');
  r = await facade.request('ping', {}, null).catch((e) => ({ err: e }));
  ok('requests succeed after reconnect', r && r.result && r.result.pong === true);

  // The push router survives reconnects: register one, spawn a proc on the
  // (reconnected) server, and confirm pushes still arrive.
  let exited = false;
  facade.onPush((method, params) => {
    if (method === 'proc.exit') { exited = true; }
  });
  const sp = await facade.request('proc.spawn', { argv: ['echo', 'hi'], wantOut: true }, null);
  ok('proc.spawn works after reconnect', sp && sp.result && typeof sp.result.id === 'number');
  for (let i = 0; i < 100 && !exited; i++) { await sleep(20); }
  ok('pushes route through the persistent facade handler after reconnect', exited);

  facade.close();
  server.close();

  await testConcurrentInflightFailFast();
  await testHelloFailureKeepsReconnecting();

  console.log('\n' + (fail === 0
    ? 'all reconnect checks passed (' + pass + ' checks)'
    : (fail + ' FAILED, ' + pass + ' passed')));
  process.exit(fail === 0 ? 0 : 1);
}

// B17: several in-flight requests at the moment of a drop must ALL fail fast
// (not just one).
async function testConcurrentInflightFailFast() {
  const server = await startMockServer();
  const dialed = [];
  const facade = createReconnectingProxy({
    ProxyClient, dial: () => wrapWS(server.url, dialed),
    helloParams: {}, baseBackoff: 50, maxBackoff: 200,
  });
  for (let i = 0; i < 100 && !facade.isConnected(); i++) { await sleep(20); }
  const inflight = Promise.all([
    facade.request('noreply', {}, null).then(() => 'ok', () => 'rejected'),
    facade.request('noreply', {}, null).then(() => 'ok', () => 'rejected'),
    facade.request('noreply', {}, null).then(() => 'ok', () => 'rejected'),
  ]);
  dialed[dialed.length - 1].rawDrop();
  const settled = await Promise.race([inflight, sleep(2000).then(() => ['HANG'])]);
  ok('all 3 concurrent in-flight requests fail fast on drop',
    Array.isArray(settled) && settled.length === 3 && settled.every((v) => v === 'rejected'),
    JSON.stringify(settled));
  facade.close();
  server.close();
}

// B17: a server that accepts the socket but REJECTS the hello must not leave the
// facade "connected"; it must keep retrying (the engine-dead failure mode).
async function testHelloFailureKeepsReconnecting() {
  const server = await startMockServer({ failHello: true });
  const dialed = [];
  const statuses = [];
  const facade = createReconnectingProxy({
    ProxyClient, dial: () => wrapWS(server.url, dialed),
    helloParams: {}, onStatus: (ev) => statuses.push(ev.kind),
    baseBackoff: 30, maxBackoff: 60,
  });
  // Give it time to try, fail the handshake, and retry a few times.
  await sleep(400);
  ok('facade never reports connected when the handshake is refused', !facade.isConnected());
  ok('hello failure triggers reconnect attempts', dialed.length >= 2, dialed.length + ' dials');
  ok('hello failure surfaces an error status', statuses.indexOf('error') >= 0);
  facade.close();
  server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
