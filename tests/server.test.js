import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAppServer } from '../server.js';

test('локальный сервер: приложение, модули, CSP и запрет доступа к исходным данным/секретам', async t => {
  const server = createAppServer(); server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Электрокомплект/);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'none'/);
  for (const module of ['app', 'engine', 'demo', 'validation', 'workflow']) {
    assert.equal((await fetch(`${url}/src/${module}.js`)).status, 200, module);
  }
  for (const path of ['/.env', '/.git/config', '/package.json', '/data/demo.json', '/src/../server.js', '/%2e%2e/.git/config']) {
    assert.equal((await fetch(`${url}${path}`)).status, 404, path);
  }
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 405);
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
});
