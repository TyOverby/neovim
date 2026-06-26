// wasm/proxy-reconnect.js - the ReconnectingProxy (stage 5, phase 6).
//
// Stage 4 opened ONE proxy WebSocket and, on close, failed in-flight requests
// but neither rejected FUTURE requests nor reconnected — so a blip left the
// editor's IO permanently dead (and a syscall issued during the outage window
// hung on the stale-but-open client). Stage 5 wraps the transport in a
// reconnecting facade that implements the reconnection contract from stage5.md:
//
//   The browser engine is the only durable state. On any disconnect, in-flight
//   ops fail fast (the syscalls' -EIO rejection arm fires — no hang), the dead
//   client is CLOSED (so ops issued during the outage also fail fast, the Spike B
//   finding), then the transport reconnects with backoff so the NEXT op succeeds.
//
// The facade is STABLE across reconnects: the js-libraries register their push
// router on it ONCE (and chain via __nvimPushChain on it), so every reconnected
// client forwards pushes to that same persistent handler. `request` delegates to
// the current live client when connected and fast-rejects otherwise.
//
// Transport-agnostic + dependency-free so it is testable in Node: the caller
// supplies `dial()` returning a browser-WebSocket-shaped object (the engine
// worker passes `() => new WebSocket(url)`; a Node test wraps the `ws` package).
'use strict';

(function () {
  // createReconnectingProxy(opts) -> stable facade { request, onPush, close,
  //   isConnected }.
  //
  // opts:
  //   ProxyClient  - the wasm/proxy-client.js module (createProxyClient).
  //   dial()       - returns a browser-WebSocket-shaped object: settable
  //                  binaryType/onopen/onmessage/onclose/onerror, send(data),
  //                  close(). onmessage receives { data }.
  //   helloParams  - the handshake params ({ mount, root, ... }); the client
  //                  sends its protocol version automatically.
  //   onHello(res) - optional; called with the hello ack's `result` object on each
  //                  successful (re)connect (e.g. { config, serverVersion, user }).
  //                  Lets the worker read server-reported identity (the proxied
  //                  user → $USER) before booting the engine.
  //   onStatus(ev) - optional; ev.kind in connected|disconnected|error|reconnecting.
  //   baseBackoff  - first reconnect delay ms (default 300).
  //   maxBackoff   - backoff ceiling ms (default 30000).
  function createReconnectingProxy(opts) {
    var ProxyClient = opts.ProxyClient;
    var dial = opts.dial;
    var helloParams = opts.helloParams || {};
    var onHello = opts.onHello || function () {};
    var onStatus = opts.onStatus || function () {};
    var baseBackoff = opts.baseBackoff || 300;
    var maxBackoff = opts.maxBackoff || 30000;

    var current = null;       // the live proxy client when connected, else null
    var connected = false;
    var stopped = false;
    var attempts = 0;         // consecutive failed/closed connects (drives backoff)
    var reconnectTimer = null;
    var pushHandler = null;   // the persistent push router (survives reconnects)

    var facade = {
      // Delegate to the live client; fast-reject when not connected so a
      // suspended syscall's .then(_, ()=>-EIO) arm fires instead of hanging.
      request: function (method, params, payload) {
        if (stopped) { return Promise.reject(new Error('proxy: stopped')); }
        if (!connected || !current) { return Promise.reject(new Error('proxy: disconnected')); }
        return current.request(method, params, payload);
      },
      // The js-libraries install their (composed) push router here, ONCE. The
      // facade forwards every reconnected client's pushes to it.
      onPush: function (fn) { pushHandler = fn; },
      isConnected: function () { return connected; },
      // Tear down for good (no reconnect). Used on engine shutdown.
      close: function () {
        stopped = true;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        connected = false;
        var c = current; current = null;
        if (c) { try { c.close(); } catch (_e) {} }
      },
    };

    function connect() {
      if (stopped) { return; }
      var ws;
      try { ws = dial(); }
      catch (e) { scheduleReconnect(); return; }
      try { ws.binaryType = 'arraybuffer'; } catch (_e) {}

      var transport = {
        send: function (data) { ws.send(data); },
        close: function () { try { ws.close(); } catch (_e) {} },
      };
      var client = ProxyClient.createProxyClient(transport);
      // Forward this client's pushes to the persistent facade handler.
      client.onPush(function (method, params, payload) {
        if (pushHandler) { try { pushHandler(method, params, payload); } catch (_e) {} }
      });

      var settled = false; // guard: onclose may follow a failed hello

      ws.onmessage = function (ev) { if (transport.onFrame) { transport.onFrame(ev.data); } };
      ws.onopen = function () {
        client.hello(helloParams).then(function (ack) {
          if (stopped) { try { ws.close(); } catch (_e) {} return; }
          current = client;
          connected = true;
          attempts = 0;
          settled = true;
          try { onHello(ack && ack.result); } catch (_e) {}
          onStatus({ kind: 'connected' });
        }, function (err) {
          // Handshake failed: drop and let onclose drive the reconnect.
          onStatus({ kind: 'error', error: err });
          try { ws.close(); } catch (_e) {}
        });
      };
      ws.onerror = function (err) { onStatus({ kind: 'error', error: err }); };
      ws.onclose = function () {
        if (current === client) { current = null; }
        connected = false;
        // Spike B: close() (not just onTransportClosed) so in-flight AND future
        // requests to this dead client reject immediately — no hang in the outage.
        try { client.close(); } catch (_e) {}
        onStatus({ kind: 'disconnected' });
        attempts++;
        scheduleReconnect();
        void settled;
      };
    }

    function scheduleReconnect() {
      if (stopped || reconnectTimer) { return; }
      // Exponential backoff with a ceiling; cap the exponent so it can't overflow.
      var exp = attempts > 8 ? 8 : attempts;
      var delay = Math.min(maxBackoff, baseBackoff * Math.pow(2, exp));
      onStatus({ kind: 'reconnecting', delay: delay });
      reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    connect();
    return facade;
  }

  var API = { createReconnectingProxy: createReconnectingProxy };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API;
  } else {
    self.ProxyReconnect = API;
  }
})();
