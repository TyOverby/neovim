// wasm/src/proxy-client.ts - the shared, dependency-free IO-proxy client (Stage 4).
//
// This is the CLIENT half of the second, separate transport stage 4 adds (see
// wasm/docs/history/stage4.md): the engine worker opens its OWN connection to a server that
// performs the engine's real IO (filesystem, processes, PTY). This file is the
// transport-agnostic request/response layer that rides that connection; it knows
// nothing about WebSockets or worker_threads -- the host hands it a `transport`.
//
// It mirrors the host-provides-transport / lib-sets-callback shape of the
// existing virtual-channel pattern in wasm/nvim_io.js (there the host provides
// `postOutput` and the lib sets `notify`): here the host provides `send`/`close`
// and the client sets `transport.onFrame`. No msgpack, no npm deps -- JSON +
// DataView/TextEncoder/TextDecoder only (present in both Node and workers).
//
// It must load BOTH as a Node module (`require`) AND in a classic worker via
// `importScripts` (global self.ProxyClient) -- the build (wasm/build-ts.sh) emits
// this TypeScript as a UMD module that does both. This is the SOURCE OF TRUTH;
// the emitted proxy-client.js is a gitignored build artifact.
//
// ============================================================================
// THE WIRE FRAME PROTOCOL
// ============================================================================
// One wire frame = a single binary message, laid out as:
//
//     uint32LE headerLen | headerJSON (utf8, headerLen bytes) | payloadBytes?
//
//   * headerLen   - little-endian uint32: the byte length of the header JSON.
//   * headerJSON  - a UTF-8 JSON control object (shapes below).
//   * payloadBytes- OPTIONAL raw binary trailer (everything after the header).
//                   Phase 1 mostly uses empty payloads, but the format supports
//                   a trailing binary payload (file/stdio bytes in later phases)
//                   and the encode/decode helpers round-trip it exactly.
//
// Header shapes (the `t` field tags the frame kind):
//   request:  { t:'req',  id:<int>, method:<string>, params:<json> }
//   response: { t:'res',  id:<int>, ok:<bool>, result:<json>, error:<string|undef> }
//   push:     { t:'push', method:<string>, params:<json> }   (server->client, no id)
//   hello:    { t:'hello', params:<json> }                   (client->server handshake)
//
// A response correlates to a request by `id`. A push has no id (it is an
// unsolicited server->client message: stdout chunks / process exit, later). The
// hello is the client's handshake; the server acks it with a `res`-shaped frame
// carrying the same handshake id this client assigns it.
// ============================================================================

// The byte channel the host hands the client: it provides send/close, the client
// assigns transport.onFrame and the host calls it for each inbound message.
export interface ProxyTransport {
  send(data: Uint8Array): void;
  close?(): void;
  onFrame?: (data: any) => void;
}

// A decoded wire frame.
export interface ProxyFrame {
  header: any;
  payload: Uint8Array;
}

// The client surface createProxyClient returns.
export interface ProxyClientInstance {
  request(method: string, params?: any, payload?: any): Promise<{ result: any; payload: Uint8Array }>;
  hello(params?: any): Promise<{ result: any; payload: Uint8Array }>;
  onPush(fn: (method: string, params: any, payload: Uint8Array) => void): void;
  close(): void;
  onTransportClosed(): void;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// Normalize whatever the transport handed us (string | Uint8Array |
// ArrayBuffer | Node Buffer | ArrayBufferView) into a Uint8Array we can read.
function toU8(data: any): Uint8Array {
  if (data instanceof Uint8Array) { return data; }
  if (typeof data === 'string') { return enc.encode(data); }
  if (data instanceof ArrayBuffer) { return new Uint8Array(data); }
  if (data && data.buffer instanceof ArrayBuffer && typeof data.byteOffset === 'number') {
    // Any other ArrayBufferView (e.g. a Node Buffer is a Uint8Array, handled
    // above; this covers DataView / typed arrays just in case).
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new Error('proxy frame: unsupported transport data type');
}

// Encode a header object (+ optional binary payload) into ONE frame buffer.
// payload is optional: undefined/null -> a header-only frame (empty trailer).
export function encodeFrame(header: any, payload?: any): Uint8Array {
  const headerBytes = enc.encode(JSON.stringify(header));
  const pay = payload == null ? new Uint8Array(0) : toU8(payload);
  const out = new Uint8Array(4 + headerBytes.length + pay.length);
  new DataView(out.buffer).setUint32(0, headerBytes.length, true); // little-endian
  out.set(headerBytes, 4);
  if (pay.length) { out.set(pay, 4 + headerBytes.length); }
  return out;
}

// Decode ONE frame buffer back into { header, payload }. `payload` is always a
// Uint8Array (zero-length when the frame had no trailer), so callers can rely
// on it. Round-trips encodeFrame exactly (header object + payload bytes).
export function decodeFrame(data: any): ProxyFrame {
  const u8 = toU8(data);
  if (u8.length < 4) { throw new Error('proxy frame: too short (' + u8.length + ' bytes)'); }
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const headerLen = view.getUint32(0, true);
  if (4 + headerLen > u8.length) {
    throw new Error('proxy frame: header length ' + headerLen + ' exceeds frame');
  }
  const headerBytes = u8.subarray(4, 4 + headerLen);
  const header = JSON.parse(dec.decode(headerBytes));
  // Copy the payload out so it is a standalone buffer (the inbound frame's
  // backing ArrayBuffer may be transferred/reused by the host).
  const payload = u8.slice(4 + headerLen);
  return { header: header, payload: payload };
}

// createProxyClient(transport) -> { request, onPush, hello, close }
//
// transport = { send(data), close() }; the client assigns transport.onFrame =
// fn(data) and the host calls it for each inbound message (the client decodes).
export function createProxyClient(transport: ProxyTransport): ProxyClientInstance {
  if (!transport || typeof transport.send !== 'function') {
    throw new Error('createProxyClient: transport.send is required');
  }

  let nextId = 1;
  const pending: Record<string, { resolve: (v: any) => void; reject: (e: any) => void }> = Object.create(null);
  let pushHandler: ((method: string, params: any, payload: Uint8Array) => void) | null = null;
  let closed = false;

  function settleReject(err: any): void {
    const ids = Object.keys(pending);
    for (let i = 0; i < ids.length; i++) {
      const p = pending[ids[i]];
      delete pending[ids[i]];
      try { p.reject(err); } catch (_e) { /* ignore */ }
    }
  }

  // The host calls this for each inbound frame (raw transport data).
  transport.onFrame = function (data) {
    let frame: ProxyFrame;
    try { frame = decodeFrame(data); }
    catch (e) { return; }            // ignore undecodable noise
    const h = frame.header;
    if (!h || typeof h !== 'object') { return; }

    if (h.t === 'res') {
      const p = pending[h.id];
      if (!p) { return; }            // unknown/duplicate id -> ignore
      delete pending[h.id];
      if (h.ok) {
        p.resolve({ result: h.result, payload: frame.payload });
      } else {
        p.reject(new Error(h.error || 'proxy request failed'));
      }
      return;
    }

    if (h.t === 'push') {
      if (pushHandler) {
        try { pushHandler(h.method, h.params, frame.payload); } catch (_e) { /* ignore */ }
      }
      return;
    }
    // 'req' / 'hello' are server-bound; a client ignores them inbound.
  };

  // Send a `req` frame, resolve on the matching `res`. Optional binary payload.
  function request(method: string, params?: any, payload?: any): Promise<{ result: any; payload: Uint8Array }> {
    if (closed) { return Promise.reject(new Error('proxy client is closed')); }
    const id = nextId++;
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      try {
        transport.send(encodeFrame({ t: 'req', id: id, method: method, params: params }, payload));
      } catch (e) {
        delete pending[id];
        reject(e);
      }
    });
  }

  // The handshake: send a `hello` frame, resolve on its ack (a `res` with the
  // hello's id). We reuse the request-id correlation by giving the hello an id
  // and tracking it in `pending` exactly like a request.
  function hello(params?: any): Promise<{ result: any; payload: Uint8Array }> {
    if (closed) { return Promise.reject(new Error('proxy client is closed')); }
    const id = nextId++;
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      try {
        transport.send(encodeFrame({ t: 'hello', id: id, params: params }));
      } catch (e) {
        delete pending[id];
        reject(e);
      }
    });
  }

  function onPush(fn: (method: string, params: any, payload: Uint8Array) => void): void { pushHandler = fn; }

  function close(): void {
    if (closed) { return; }
    closed = true;
    settleReject(new Error('proxy client closed; in-flight request aborted'));
    try { if (typeof transport.close === 'function') { transport.close(); } } catch (_e) { /* ignore */ }
  }

  // If the host learns the transport dropped, it can call this to fail all
  // in-flight requests without tearing the transport down again.
  function onTransportClosed(): void {
    if (closed) { return; }
    settleReject(new Error('proxy transport closed; in-flight request aborted'));
  }

  return {
    request: request,
    hello: hello,
    onPush: onPush,
    close: close,
    onTransportClosed: onTransportClosed,
  };
}
