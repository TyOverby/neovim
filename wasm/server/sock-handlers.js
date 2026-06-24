// wasm/server/sock-handlers.js - the server-side TCP socket + DNS proxy handlers
// (Stage 4 -- the last IO seam). Registered onto the proxy server's handler
// registry by registerSockHandlers(registry); implemented with Node `net` + `dns`.
//
// ============================================================================
// PROTOCOL (mirrors wasm/nvim_sock_proxy.js)
// ============================================================================
//   sock.connect     {host, port} | {path}   -> {id}        (server connection id;
//                                                            {path} = unix socket)
//   sock.write       {id} + payload<bytes>   -> {ok}        (write to the socket)
//   sock.close       {id}                    -> {ok}        (end/destroy the socket)
//   sock.getaddrinfo {host, service}         -> {addrs:[{family,address,port}]}
//   server pushes (ctx.push):
//     sock.connect_ok  {id}                  (the 'connect' event fired)
//     sock.connect_err {id, code}            (the 'error' event before connect)
//     sock.data        {id} + payload<bytes> (inbound socket bytes)
//     sock.closed      {id}                  (the peer closed / 'end' or 'close')
//
// ============================================================================
// SECURITY (see stage4.md "Security model")
// ============================================================================
// Outbound TCP is the WHOLE POINT of this seam ("reach the network"), so there is
// no jail on the destination: the server can connect to ANY host it can route to
// (loopback, LAN, the internet), with the server process's network privileges.
// This is consistent with the single-user "edit my own box" model and the
// loopback-only bind of the server itself (no remote client can reach it without
// an explicit opt-in / SSH forward). Connections are tracked PER CONNECTION and
// destroyed when the ws drops, so a closed tab/worker leaves no dangling sockets.
'use strict';

const net = require('net');
const dns = require('dns');

// Per-connection socket table lives on ctx (created lazily).
function sockTable(ctx) {
  if (!ctx.__sockConns) {
    ctx.__sockConns = { next: 1, byId: Object.create(null) };
  }
  return ctx.__sockConns;
}

// A small service-name -> port map for the common cases nvim/luv use. Most
// callers pass a NUMERIC service (AI_NUMERICSERV in socket.c; luv passes the
// port number), so this is only a fallback for named services.
const SERVICES = {
  http: 80, https: 443, ftp: 21, ssh: 22, telnet: 23, smtp: 25,
  domain: 53, dns: 53, pop3: 110, imap: 143, ldap: 389,
};
function servicePort(service) {
  if (service == null || service === '') { return 0; }
  const n = parseInt(service, 10);
  if (Number.isFinite(n) && String(n) === String(service).trim()) { return n; }
  const named = SERVICES[String(service).toLowerCase()];
  return (typeof named === 'number') ? named : 0;
}

function registerSockHandlers(registry) {
  // sock.connect: open a real outbound TCP connection. Returns the per-connection
  // id synchronously-ish; the 'connect'/'error' result is delivered as a push
  // (sock.connect_ok / sock.connect_err) so the wasm side fires the libuv
  // connect cb only once the real connect resolves (matching uv_tcp_connect).
  registry.register('sock.connect', function (params, payload, ctx) {
    // Two transports share this handler: TCP ({host,port}) and UNIX-domain
    // ({path}). A `path` selects a unix socket (Node net.connect(path)); else
    // host:port. Everything downstream (data/write/close, cleanup) is identical.
    const isUnix = (typeof params.path === 'string' && params.path.length > 0);
    let host, port;
    if (!isUnix) {
      host = (typeof params.host === 'string' && params.host) ? params.host : '127.0.0.1';
      port = params.port | 0;
      if (!port) {
        const e = new Error('sock.connect: missing/invalid port');
        e.errno = 22;
        throw e;
      }
    }

    const tbl = sockTable(ctx);
    const id = tbl.next++;
    const rec = { id: id, socket: null, connected: false, closed: false };
    tbl.byId[id] = rec;

    let socket;
    try {
      // Node net.connect with a STRING path = a unix-domain socket; with an
      // options object = TCP.
      socket = isUnix ? net.connect(params.path) : net.connect({ host: host, port: port });
    } catch (e) {
      // Synchronous failure (rare): report as a connect error push.
      setImmediate(function () { ctx.push('sock.connect_err', { id: id, code: (e && e.code) || 'ECONNREFUSED' }); });
      return { result: { id: id } };
    }
    rec.socket = socket;
    // TCP_NODELAY is meaningless on a unix socket; only set it for TCP.
    if (!isUnix) { try { socket.setNoDelay(true); } catch (e) { /* ignore */ } }

    socket.on('connect', function () {
      rec.connected = true;
      ctx.push('sock.connect_ok', { id: id });
    });
    socket.on('data', function (buf) {
      ctx.push('sock.data', { id: id }, buf);
    });
    socket.on('error', function (err) {
      if (rec.closed) { return; }
      if (!rec.connected) {
        // Pre-connect failure: a connect error (the wasm side fires the connect
        // cb with UV_ECONNREFUSED so socket.c retries / reports refused).
        rec.closed = true;
        ctx.push('sock.connect_err', { id: id, code: (err && err.code) || 'ECONNREFUSED' });
      } else {
        // Post-connect error: surface as a close (EOF) to the read side.
        rec.closed = true;
        ctx.push('sock.closed', { id: id });
      }
    });
    socket.on('end', function () {
      // Peer half-closed: EOF the read side. (The socket may still be writable;
      // nvim's read_cb sees UV_EOF, which is the contract.)
      if (!rec.closed) { ctx.push('sock.closed', { id: id }); }
    });
    socket.on('close', function () {
      if (!rec.closed) {
        rec.closed = true;
        // If we never connected, a 'close' without a prior 'connect'/'error' is
        // still a failed connect; otherwise it's a normal EOF.
        if (!rec.connected) { ctx.push('sock.connect_err', { id: id, code: 'ECONNREFUSED' }); }
        else { ctx.push('sock.closed', { id: id }); }
      }
    });

    return { result: { id: id } };
  });

  // sock.write: write the payload bytes to the socket.
  registry.register('sock.write', function (params, payload, ctx) {
    const tbl = sockTable(ctx);
    const rec = tbl.byId[params.id];
    if (rec && rec.socket && !rec.closed && payload && payload.length) {
      try { rec.socket.write(Buffer.from(payload)); } catch (e) { /* closed */ }
    }
    return { result: { ok: true } };
  });

  // sock.close: end + destroy the socket (nvim closed its side).
  registry.register('sock.close', function (params, payload, ctx) {
    const tbl = sockTable(ctx);
    const rec = tbl.byId[params.id];
    if (rec && rec.socket) {
      rec.closed = true;
      try { rec.socket.end(); } catch (e) { /* ignore */ }
      try { rec.socket.destroy(); } catch (e) { /* ignore */ }
      delete tbl.byId[params.id];
    }
    return { result: { ok: true } };
  });

  // sock.getaddrinfo: resolve `host` to all addresses; map the service to a port.
  // Returns [{family, address, port}, ...]. A bare numeric/loopback host resolves
  // trivially; a name uses Node's dns.lookup (which honors the system resolver).
  registry.register('sock.getaddrinfo', function (params, payload, ctx) {
    const host = (typeof params.host === 'string') ? params.host : '';
    const port = servicePort(params.service);
    return new Promise(function (resolve) {
      // `all: true` returns every resolved address (v4 + v6), matching
      // getaddrinfo's multi-result contract. An empty/whitespace host (rare;
      // means "any") resolves to loopback.
      const lookupHost = host && host.trim() ? host : '127.0.0.1';
      dns.lookup(lookupHost, { all: true, verbatim: true }, function (err, addresses) {
        if (err || !addresses || !addresses.length) {
          // Fall back: if the host already parses as a literal IP, return it as-is
          // (dns.lookup normally handles literals, but be defensive).
          if (net.isIP(lookupHost)) {
            resolve({ result: { addrs: [{ family: net.isIPv6(lookupHost) ? 6 : 4, address: lookupHost, port: port }] } });
            return;
          }
          resolve({ result: { addrs: [] } });
          return;
        }
        const addrs = addresses.map(function (a) {
          return { family: a.family, address: a.address, port: port };
        });
        resolve({ result: { addrs: addrs } });
      });
    });
  });
}

// Destroy every still-open socket of a connection (called when the ws drops, so
// a closed tab/worker leaves no dangling sockets). Best-effort.
function cleanupSockets(ctx) {
  if (!ctx.__sockConns) { return; }
  const byId = ctx.__sockConns.byId;
  for (const id of Object.keys(byId)) {
    const rec = byId[id];
    if (rec && rec.socket && !rec.closed) {
      rec.closed = true;
      try { rec.socket.destroy(); } catch (e) { /* ignore */ }
    }
  }
}

module.exports = {
  registerSockHandlers: registerSockHandlers,
  cleanupSockets: cleanupSockets,
};
