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
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  for (const module of ['app', 'engine', 'demo', 'validation', 'workflow', 'analyst-payload']) {
    assert.equal((await fetch(`${url}/src/${module}.js`)).status, 200, module);
  }
  for (const path of ['/.env', '/.env.example', '/.git/config', '/package.json', '/server.js', '/data/demo.json', '/src/../server.js', '/%2e%2e/.git/config']) {
    assert.equal((await fetch(`${url}${path}`)).status, 404, path);
  }
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 405);
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
});

test('AI status and analyze require local origin and do not expose the server key', async t => {
  const secret = 'synthetic-server-test-key-do-not-print-012345';
  let calls = 0;
  const server = createAppServer({
    getAiConfig: () => ({ apiKey: secret, model: 'gpt-6-luna' }),
    analyzer: async payload => { calls++; return { answer: `Проверена сводка ${payload.plan.datasetType}.`, model: 'gpt-6-luna' }; },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const status = await fetch(`${url}/api/ai/status`);
  const statusBody = await status.json();
  assert.deepEqual(statusBody, { configured: true, model: 'gpt-6-luna' });
  assert.doesNotMatch(JSON.stringify(statusBody), /synthetic-server/u);
  const payload = { question: 'Что проверить?', plan: { datasetType: 'synthetic_demo', totalPositions: 2 } };
  const crossOrigin = await fetch(`${url}/api/ai/analyze`, { method: 'POST', headers: { Origin: 'https://external.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(crossOrigin.status, 403); assert.equal(calls, 0);
  const analyzed = await fetch(`${url}/api/ai/analyze`, { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(analyzed.status, 200);
  assert.deepEqual(await analyzed.json(), { answer: 'Проверена сводка synthetic_demo.', model: 'gpt-6-luna' });
  assert.equal(calls, 1);
});

test('AI API gives safe setup errors, limits request size and rejects concurrent requests', async t => {
  const noKeyServer = createAppServer({ getAiConfig: () => ({ apiKey: '', model: 'gpt-6-luna' }) });
  noKeyServer.listen(0, '127.0.0.1'); await once(noKeyServer, 'listening');
  t.after(() => new Promise(resolve => { noKeyServer.close(resolve); noKeyServer.closeAllConnections(); }));
  const noKeyUrl = `http://127.0.0.1:${noKeyServer.address().port}`;
  const noKeyStatus = await (await fetch(`${noKeyUrl}/api/ai/status`)).json();
  assert.deepEqual(noKeyStatus, { configured: false, model: 'gpt-6-luna' });
  const missing = await fetch(`${noKeyUrl}/api/ai/analyze`, { method: 'POST', headers: { Origin: noKeyUrl, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(missing.status, 503); assert.match((await missing.json()).error, /OPENAI_API_KEY/u);

  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const busyServer = createAppServer({
    getAiConfig: () => ({ apiKey: 'synthetic-busy-test-key-0123456789', model: 'gpt-6-luna' }),
    analyzer: async () => { enter(); await gate; return { answer: 'Готово.', model: 'gpt-6-luna' }; },
  });
  busyServer.listen(0, '127.0.0.1'); await once(busyServer, 'listening');
  t.after(() => new Promise(resolve => { busyServer.close(resolve); busyServer.closeAllConnections(); }));
  const busyUrl = `http://127.0.0.1:${busyServer.address().port}`;
  const oversized = await fetch(`${busyUrl}/api/ai/analyze`, { method: 'POST', headers: { Origin: busyUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(33_000) }) });
  assert.equal(oversized.status, 413);
  const request = () => fetch(`${busyUrl}/api/ai/analyze`, { method: 'POST', headers: { Origin: busyUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  const first = request(); await entered;
  const second = await request(); assert.equal(second.status, 409);
  release(); assert.equal((await first).status, 200);
});

test('локальный импорт принимает только JSON с того же origin и возвращает набор без записи файлов', async t => {
  let calls = 0;
  const server = createAppServer({ importSources: async paths => { calls++; return { schemaVersion: 2, paths, products: [] }; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const sources = await fetch(`${url}/api/sources`);
  assert.equal(sources.status, 200); assert.ok((await sources.json()).paths.systeme);
  const rejected = await fetch(`${url}/api/import`, { method: 'POST', headers: { Origin: 'https://external.invalid', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(rejected.status, 403); assert.equal(calls, 0);
  const badType = await fetch(`${url}/api/import`, { method: 'POST', body: '{}' });
  assert.equal(badType.status, 415);
  const imported = await fetch(`${url}/api/import`, { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: { systeme: 'C:/fictional', iek: '' } }) });
  assert.equal(imported.status, 200); assert.equal((await imported.json()).schemaVersion, 2); assert.equal(calls, 1);
});
