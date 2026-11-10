// Test-only localhost TLS terminator. No keys/tokens/application bodies are logged.
// E2E_TLS_PORT (default 8444) -> 127.0.0.1:E2E_UI_PORT (default 3000).
import { createServer } from 'node:https';
import { request as upstreamRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
const port = Number(process.env.E2E_TLS_PORT ?? 8444);
const upstreamPort = Number(process.env.E2E_UI_PORT ?? 3000);
if (!Number.isInteger(port) || !Number.isInteger(upstreamPort)) throw new Error('invalid E2E_TLS_PORT/E2E_UI_PORT');
const tls = { cert: await readFile(new URL('../certs/cert.pem', import.meta.url)), key: await readFile(new URL('../certs/key.pem', import.meta.url)) };
const servers = [];
for (const [listenPort, targetPort] of [[port, upstreamPort]]) {
  const server = createServer(tls, (req, res) => {
    const upstream = upstreamRequest({ hostname: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host ?? `localhost:${listenPort}` } }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  server.listen(listenPort, '127.0.0.1'); servers.push(server);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { for (const server of servers) server.close(); });
