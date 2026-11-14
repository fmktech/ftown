// Stand-in for the solo panel (Next standalone server.js) inside the chaos box.
// The bridge panel manager spawns `node server.js` with HOSTNAME/PORT set and
// probes HEAD http://127.0.0.1:<port>/ (status < 500 = healthy).
'use strict';
const http = require('node:http');
const port = Number(process.env.PORT);
const host = process.env.HOSTNAME || '127.0.0.1';
if (!Number.isInteger(port) || port <= 0) {
  process.stderr.write('panel-stub: PORT is not set\n');
  process.exit(1);
}
http
  .createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(req.method === 'HEAD' ? undefined : 'chaos panel stub\n');
  })
  .on('error', (err) => {
    process.stderr.write(`panel-stub: ${err.message}\n`);
    process.exit(1);
  })
  .listen(port, host);
process.on('SIGTERM', () => process.exit(0));
