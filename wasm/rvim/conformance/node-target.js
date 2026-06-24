// node-target.js — launch the stage-4 Node reference server on an ephemeral
// loopback port for the Go conformance harness. Prints `PORT=<n>` on stdout once
// listening; the Go runner reads that and connects ws://127.0.0.1:<n>/proxy.
//
//   node node-target.js --root <dir>
//
// This is the "reference oracle" target: the Go server (later phases) must pass
// the SAME scenarios this server passes.
'use strict';

const path = require('path');
const { createServer } = require(path.resolve(__dirname, '../../server/server.js'));

let root = process.cwd();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root') { root = path.resolve(argv[++i]); }
}

const srv = createServer({ root: root, port: 0 });
srv.httpServer.listen(0, '127.0.0.1', function () {
  const addr = srv.httpServer.address();
  process.stdout.write('PORT=' + addr.port + '\n');
});

// Exit cleanly when the harness closes our stdin (it parents us).
process.stdin.on('end', function () { process.exit(0); });
process.stdin.resume();
