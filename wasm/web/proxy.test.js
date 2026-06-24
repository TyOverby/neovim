// wasm/web/proxy.test.js - standalone test of the Stage 4 IO-proxy protocol +
// server skeleton, WITHOUT the engine/wasm (pure JS).
//
// Two parts:
//   A. An in-memory LINKED transport pair (two objects whose send() calls the
//      other's onFrame): a createProxyClient on one side, the server's handler
//      dispatch on the other. Asserts the protocol end to end (ping, echo,
//      echo-with-payload, unknown-method reject, handler-throw reject, server
//      push -> onPush, close() rejects in-flight).
//   B. A REAL WebSocket smoke: start server.js on an ephemeral localhost port,
//      connect a `ws` client through createProxyClient, assert hello acks and
//      ping round-trips, then shut down cleanly.
//
// Run:  node wasm/web/proxy.test.js
'use strict';

const path = require('path');

const ProxyClient = require('../proxy-client.js');
const { createProxyClient, encodeFrame, decodeFrame } = ProxyClient;
const serverMod = require('../server/server.js');

// ---- tiny test harness (mirrors e2e.test.js) -------------------------------
let failures = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) { console.log('  ok   - ' + msg); }
  else { failures++; console.log('  FAIL - ' + msg); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ---- in-memory linked transport pair ---------------------------------------
// Returns { client, server } transports. Each transport's send() delivers the
// frame to the OTHER's onFrame on a later macrotask (setTimeout 0), so the wire
// is asynchronous like a real socket (no synchronous reentrancy).
function linkedPair() {
  const a = { onFrame: null, closed: false };
  const b = { onFrame: null, closed: false };
  a.send = function (data) {
    if (b.closed) { return; }
    setTimeout(function () { if (b.onFrame && !b.closed) { b.onFrame(data); } }, 0);
  };
  b.send = function (data) {
    if (a.closed) { return; }
    setTimeout(function () { if (a.onFrame && !a.closed) { a.onFrame(data); } }, 0);
  };
  a.close = function () { a.closed = true; };
  b.close = function () { b.closed = true; };
  return { client: a, server: b };
}

// Drive the server-side handler dispatch over a raw transport (the in-memory
// half). This mirrors server.js serveConnection but for the linked pair: decode
// inbound frames, dispatch req/hello, reply. We reuse the real registry +
// handlers so the protocol under test is the production one.
function runServerSide(transport, registry) {
  const ctx = {
    config: {},
    push: function (method, params, payload) {
      transport.send(encodeFrame({ t: 'push', method: method, params: params }, payload));
    },
  };
  transport.onFrame = async function (data) {
    let frame;
    try { frame = decodeFrame(data); } catch (_e) { return; }
    const h = frame.header;
    if (h.t === 'hello') {
      ctx.config = Object.assign({}, ctx.config, h.params || {});
      transport.send(encodeFrame({ t: 'res', id: h.id, ok: true, result: { hello: true, config: ctx.config } }));
      return;
    }
    if (h.t === 'req') {
      const fn = registry.handlers[h.method];
      if (!fn) {
        transport.send(encodeFrame({ t: 'res', id: h.id, ok: false, error: "unknown method '" + h.method + "'" }));
        return;
      }
      try {
        const ret = await fn(h.params, frame.payload, ctx);
        let result = ret, outPayload;
        if (ret && typeof ret === 'object' && ('result' in ret || 'payload' in ret) && !Array.isArray(ret)) {
          result = ret.result; outPayload = ret.payload;
        }
        transport.send(encodeFrame({ t: 'res', id: h.id, ok: true, result: result }, outPayload));
      } catch (err) {
        transport.send(encodeFrame({ t: 'res', id: h.id, ok: false, error: (err && err.message) || String(err) }));
      }
    }
  };
  return ctx;
}

async function inMemoryTests() {
  console.log('# in-memory linked transport pair');

  // 0. Frame codec round-trips header + binary payload exactly.
  const payIn = new Uint8Array([0, 1, 2, 250, 255, 100]);
  const round = decodeFrame(encodeFrame({ t: 'req', id: 7, method: 'm', params: { a: 1 } }, payIn));
  ok(round.header.id === 7 && round.header.method === 'm' && round.header.params.a === 1,
     'encodeFrame/decodeFrame round-trips the header');
  ok(round.payload.length === payIn.length && round.payload.every(function (v, i) { return v === payIn[i]; }),
     'encodeFrame/decodeFrame round-trips the binary payload byte-for-byte');
  const empty = decodeFrame(encodeFrame({ t: 'push', method: 'x', params: null }));
  ok(empty.payload.length === 0, 'a header-only frame decodes to a zero-length payload');

  const pair = linkedPair();
  const client = createProxyClient(pair.client);
  const registry = serverMod.createRegistry();
  serverMod.registerPhase1Handlers(registry);
  const ctx = runServerSide(pair.server, registry);

  // 1. ping round-trips.
  const ping = await client.request('ping', null);
  ok(ping.result && ping.result.pong === true && typeof ping.result.now === 'number',
     'ping round-trips -> { pong:true, now:<int> } (now=' + (ping.result && ping.result.now) + ')');

  // 2. echo returns params.
  const echo = await client.request('echo', { hello: 'world', n: 42 });
  ok(echo.result && echo.result.hello === 'world' && echo.result.n === 42,
     'echo returns the params back');

  // 3. echo with a binary payload returns the same bytes.
  const bytes = new Uint8Array([9, 8, 7, 6, 5, 200, 0, 255]);
  const echoP = await client.request('echo', { tag: 'bin' }, bytes);
  ok(echoP.result && echoP.result.tag === 'bin', 'echo-with-payload returns params');
  ok(echoP.payload.length === bytes.length && echoP.payload.every(function (v, i) { return v === bytes[i]; }),
     'echo-with-payload returns the SAME bytes back');

  // 4. unknown method rejects with an error.
  let unknownErr = null;
  try { await client.request('does_not_exist', {}); }
  catch (e) { unknownErr = e; }
  ok(unknownErr && /unknown method/.test(unknownErr.message),
     'an unknown method rejects with an error ("' + (unknownErr && unknownErr.message) + '")');

  // 5. a handler throw propagates as a rejection.
  registry.register('boom', function () { throw new Error('kaboom'); });
  let boomErr = null;
  try { await client.request('boom', {}); }
  catch (e) { boomErr = e; }
  ok(boomErr && /kaboom/.test(boomErr.message),
     'a handler throw propagates as a rejection ("' + (boomErr && boomErr.message) + '")');

  // 6. a server push reaches onPush.
  let pushed = null;
  client.onPush(function (method, params, payload) { pushed = { method: method, params: params, payload: payload }; });
  ctx.push('stdout', { chunk: 'hi' }, new Uint8Array([1, 2, 3]));
  await sleep(20);
  ok(pushed && pushed.method === 'stdout' && pushed.params.chunk === 'hi',
     'a server push reaches onPush(method, params, payload)');
  ok(pushed && pushed.payload && pushed.payload.length === 3 && pushed.payload[0] === 1,
     'a server push carries its binary payload to onPush');

  // 7. hello acks.
  const hello = await client.hello({ mount: '/host', root: '/srv/project' });
  ok(hello.result && hello.result.hello === true && hello.result.config &&
     hello.result.config.mount === '/host' && hello.result.config.root === '/srv/project',
     'hello acks and echoes the handshake config');

  // 8. close() rejects in-flight requests. Use a never-answered method: a fresh
  //    pair with NO server side, so the request hangs until close() aborts it.
  const dead = linkedPair();
  const deadClient = createProxyClient(dead.client);   // nothing reads dead.server
  let inflightErr = null;
  const inflight = deadClient.request('ping', null).catch(function (e) { inflightErr = e; });
  await sleep(5);
  deadClient.close();
  await inflight;
  ok(inflightErr && /closed/.test(inflightErr.message),
     'close() rejects in-flight requests ("' + (inflightErr && inflightErr.message) + '")');

  // 9. requests after close() reject immediately.
  let afterCloseErr = null;
  try { await deadClient.request('ping', null); }
  catch (e) { afterCloseErr = e; }
  ok(afterCloseErr && /closed/.test(afterCloseErr.message),
     'a request after close() rejects immediately');
}

// ---- real WebSocket smoke (server.js + ws client) --------------------------
async function realWebSocketTest() {
  console.log('# real WebSocket smoke (server.js + ws client)');

  const WebSocket = require(path.join(__dirname, 'node_modules', 'ws'));
  const srv = serverMod.createServer({ root: '/tmp/proxy-test-root' });

  // Listen on an ephemeral loopback port (port 0 -> OS-assigned).
  await new Promise(function (resolve) { srv.httpServer.listen(0, '127.0.0.1', resolve); });
  const port = srv.httpServer.address().port;
  const url = 'ws://127.0.0.1:' + port + '/proxy';

  const ws = new WebSocket(url);
  const transport = {
    send: function (data) { ws.send(data); },
    close: function () { try { ws.close(); } catch (_e) {} },
  };
  const client = createProxyClient(transport);
  ws.on('message', function (d) { if (transport.onFrame) { transport.onFrame(d); } });

  await new Promise(function (resolve, reject) {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ok(true, 'connected to server.js /proxy over a real WebSocket on port ' + port);

  // hello acks (carrying the mount/root the engine worker would send).
  const hello = await client.hello({ mount: '/host', root: '/srv/project' });
  ok(hello.result && hello.result.hello === true && hello.result.config.mount === '/host',
     'hello acks over the real WebSocket (config.mount = ' + hello.result.config.mount + ')');

  // ping round-trips.
  const ping = await client.request('ping', null);
  ok(ping.result && ping.result.pong === true && typeof ping.result.now === 'number',
     'ping round-trips over the real WebSocket');

  // echo-with-payload over the real socket (binary frames survive ws too).
  const bytes = new Uint8Array([42, 0, 17, 255]);
  const echo = await client.request('echo', { via: 'ws' }, bytes);
  ok(echo.result && echo.result.via === 'ws' &&
     echo.payload.length === bytes.length && echo.payload[3] === 255,
     'echo-with-payload round-trips over the real WebSocket');

  // Shut down cleanly.
  client.close();
  await new Promise(function (resolve) { srv.wss.close(function () { srv.httpServer.close(resolve); }); });
  ok(true, 'server shut down cleanly');
}

async function main() {
  await inMemoryTests();
  await realWebSocketTest();

  console.log('');
  if (failures) { console.log(failures + ' of ' + checks + ' proxy check(s) FAILED'); process.exit(1); }
  console.log('all proxy checks passed (' + checks + ' checks)');
  process.exit(0);
}

main().catch(function (e) { console.error('proxy.test: ' + ((e && e.stack) || String(e))); process.exit(1); });
