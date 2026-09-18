import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { localAdminRequest } from './local-pair-cli.js';

test('local admin client uses loopback bearer without Origin and rejects redirects', async (t) => {
  let count = 0;
  const server = createServer((req, res) => {
    count++;
    assert.equal(req.headers.origin, undefined);
    assert.equal(req.headers.authorization, 'Bearer test-admin-secret');
    if (req.url?.endsWith('/redirect')) {
      res.writeHead(302, { Location: '/api/browser/stolen' }); res.end(); return;
    }
    assert.equal(req.url, '/api/browser/window');
    assert.equal(req.method, 'POST');
    res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  assert.deepEqual(await localAdminRequest({ port, token: 'test-admin-secret' }, 'window', 'POST', {}), { ok: true });
  await assert.rejects(localAdminRequest({ port, token: 'test-admin-secret' }, 'redirect'));
  assert.equal(count, 2);
});
