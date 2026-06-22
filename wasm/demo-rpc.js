// wasm/demo-rpc.js - Proof that the Neovim engine (wasm, in a worker) and a
// client (this main thread) communicate over shared memory.
//
// The engine runs in a worker_thread and is reachable only through a
// SharedArrayBuffer RingChannel (wasm/sab.js) - no shared fds, pipes or
// sockets. This is the substrate for the browser target (page <-> Worker).
//
// Important: the *client* (main thread) never blocks with Atomics.wait - on a
// browser page that is forbidden, and in Node it would also stall the worker's
// console forwarding. It stays event-driven and polls the ring.
//
// Run from the build output dir:  node demo-rpc.js
'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { RingChannel } = require(path.join(__dirname, 'sab.js'));

const CAP = 1 << 20;
const { sab } = RingChannel.create(CAP);
const client = new RingChannel(sab, CAP, 'client');

const worker = new Worker(path.join(__dirname, 'worker.js'), {
  workerData: { sab, cap: CAP, args: ['-u', 'NONE', '-i', 'NONE'] },
});
worker.on('error', (e) => { console.error('worker error:', e); process.exitCode = 1; });

// --- tiny msgpack helpers (just enough for this demo) ----------------------
function encodeRequest(msgid, method, params) {
  const m = Buffer.from(method);
  const head = Buffer.from([0x94, 0x00, msgid & 0xff, 0xa0 | m.length, ...m]);
  const pbufs = params.map((p) => {
    const b = Buffer.from(String(p));
    return Buffer.from([0xa0 | b.length, ...b]);
  });
  const arr = Buffer.from([0x90 | params.length, ...Buffer.concat(pbufs)]);
  return Buffer.concat([head, arr]);
}

function writeAll(ring, buf) {
  let off = 0;
  while (off < buf.length) {
    off += ring.write(buf, off, buf.length - off);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Non-blocking read: poll the ring on the event loop (no Atomics.wait).
async function readReply(ring, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ring.available() > 0) {
      const out = Buffer.alloc(ring.available());
      const n = ring.read(out, 0, out.length);
      return out.subarray(0, n);
    }
    await sleep(5);
  }
  return Buffer.alloc(0);
}

async function main() {
  await sleep(1200);  // let the engine initialize + attach its stdio channel

  console.log('[client] -> nvim_eval("1+1") over SharedArrayBuffer');
  writeAll(client.out, encodeRequest(0, 'nvim_eval', ['1+1']));

  const reply = await readReply(client.in, 8000);
  console.log('[client] <- reply bytes:', reply.toString('hex') || '(none)');
  // response is [1, msgid, err, result]; 1+1 => trailing 0x02
  const ok = reply.length >= 4 && reply[0] === 0x94 && reply[1] === 0x01 &&
             reply[reply.length - 1] === 0x02;
  console.log(ok ? 'PASS: 1+1 == 2 over shared memory ✓'
                 : 'FAIL: unexpected reply');

  client.out.close();
  client.in.close();
  await worker.terminate();
  process.exitCode = ok ? 0 : 1;
}
main();
