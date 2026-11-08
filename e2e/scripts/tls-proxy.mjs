// Test-only localhost TLS terminator. No keys/tokens/application bodies are logged.
import { createServer } from 'node:https';
import { request as upstreamRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
const tls = { cert: await readFile(new URL('../certs/cert.pem', import.meta.url)), key: await readFile(new URL('../certs/key.pem', import.meta.url)) };
const servers = [];
for (const [port, upstreamPort] of [[8444, 3000]]) {
  const server = createServer(tls, (req, res) => {
    const upstream = upstreamRequest({ hostname: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  server.listen(port, '127.0.0.1'); servers.push(server);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { for (const server of servers) server.close(); });
