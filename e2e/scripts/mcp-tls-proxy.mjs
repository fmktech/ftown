// Test-only localhost TLS terminator. No keys/tokens/application bodies are logged.
import { createServer } from 'node:https';
import { request as upstreamRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
const tls = { cert: await readFile(new URL('../certs/cert.pem', import.meta.url)), key: await readFile(new URL('../certs/key.pem', import.meta.url)) };
const servers = [];
for (const [port, upstreamPort] of [[8443, 8080], [8444, 3000]]) {
  const server = createServer(tls, (req, res) => {
    const upstream = upstreamRequest({ hostname: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  // The gateway requires WSS for the broker. Reuse its TLS origin/port.
  if (port === 8443) server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/connection/websocket') { socket.destroy(); return; }
    const upstream = upstreamRequest({ hostname: '127.0.0.1', port: 8000, path: req.url, method: req.method, headers: req.headers });
    upstream.on('upgrade', (response, peer, upstreamHead) => {
      socket.write(`HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? 'Switching Protocols'}\r\n`);
      for (let i = 0; i < response.rawHeaders.length; i += 2) socket.write(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`);
      socket.write('\r\n'); if (upstreamHead.length) socket.write(upstreamHead); if (head.length) peer.write(head);
      socket.pipe(peer).pipe(socket); socket.on('error', () => peer.destroy()); peer.on('error', () => socket.destroy());
    });
    upstream.on('error', () => socket.destroy()); upstream.end();
  });
  server.listen(port, '127.0.0.1'); servers.push(server);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { for (const server of servers) server.close(); });
