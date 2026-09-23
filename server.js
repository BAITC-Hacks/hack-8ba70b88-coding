import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { defaultSourcePaths, importLocalSources } from './src/local-import.js';
import { loadLocalEnv } from './src/env.js';
import { analyzeWithOpenAI, AnalystError } from './src/openai-client.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const hasApiKey = value => typeof value === 'string' && value.length >= 20 && value.length <= 4096 && !/\s/u.test(value);
const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ...['app', 'engine', 'real-engine', 'demo', 'validation', 'workflow'].map(name =>
    [`/src/${name}.js`, [`src/${name}.js`, 'text/javascript; charset=utf-8']]),
  ['/src/analyst-payload.js', ['src/analyst-payload.js', 'text/javascript; charset=utf-8']],
  ['/src/styles.css', ['src/styles.css', 'text/css; charset=utf-8']],
]);

export function createAppServer({ importSources = importLocalSources, analyzer = null, getAiConfig = null } = {}) {
  let importing = false;
  let analyzing = false;
  const aiConfig = getAiConfig || (() => ({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || 'gpt-6-luna' }));
  const runAnalysis = analyzer || (payload => analyzeWithOpenAI(payload, aiConfig()));
  return http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const host = request.headers.host || '';
    const trustedHost = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
    const trustedOrigin = !request.headers.origin || request.headers.origin === `http://${host}`;
    let pathname;
    try { pathname = new URL(request.url, 'http://localhost').pathname; }
    catch { response.writeHead(400).end('Некорректный адрес'); return; }
    const json = (status, value) => {
      const body = Buffer.from(JSON.stringify(value));
      const compressed = /\bgzip\b/.test(request.headers['accept-encoding'] || '') && body.length > 4096;
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(compressed ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}) });
      response.end(compressed ? gzipSync(body) : body);
    };
    if (pathname.startsWith('/api/')) {
      if (!trustedHost || !trustedOrigin) { json(403, { error: 'Доступ разрешён только из локального приложения.' }); return; }
      if (pathname === '/api/ai/status' && request.method === 'GET') {
        const config = aiConfig();
        json(200, { configured: hasApiKey(config.apiKey), model: config.model || 'gpt-6-luna' }); return;
      }
      if (pathname === '/api/ai/analyze' && request.method === 'POST') {
        if (analyzing) { json(409, { error: 'Анализ уже выполняется. Дождитесь ответа.' }); return; }
        if (!(request.headers['content-type'] || '').startsWith('application/json')) { json(415, { error: 'Ожидается JSON с краткой сводкой плана.' }); return; }
        const config = aiConfig();
        if (!hasApiKey(config.apiKey)) { json(503, { error: 'AI-аналитик не настроен: задайте OPENAI_API_KEY в локальном .env и перезапустите приложение.' }); return; }
        analyzing = true;
        try {
          const chunks = []; let size = 0;
          for await (const chunk of request) {
            size += chunk.length;
            if (size > 32_768) { json(413, { error: 'Сводка слишком велика (максимум 32 КБ). Сократите вопрос.' }); return; }
            chunks.push(chunk);
          }
          let payload;
          try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { json(400, { error: 'Не удалось прочитать сводку запроса.' }); return; }
          const result = await runAnalysis(payload);
          json(200, result);
        } catch (error) {
          if (error instanceof AnalystError) json(error.status, { error: error.message, code: error.code });
          else json(502, { error: 'AI-аналитик не смог завершить запрос. Основной расчёт плана сохранён.' });
        } finally { analyzing = false; }
        return;
      }
      if (pathname === '/api/sources' && request.method === 'GET') { json(200, { paths: defaultSourcePaths() }); return; }
      if (pathname === '/api/import' && request.method === 'POST') {
        if (importing) { json(409, { error: 'Импорт уже выполняется. Дождитесь завершения.' }); return; }
        if (!(request.headers['content-type'] || '').startsWith('application/json')) { json(415, { error: 'Ожидается application/json с путями к папкам.' }); return; }
        importing = true;
        try {
          const chunks = []; let size = 0;
          for await (const chunk of request) {
            size += chunk.length;
            if (size > 16_384) throw new Error('Слишком большой запрос. Передайте только пути к папкам.');
            chunks.push(chunk);
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const dataset = await importSources(body.paths ?? defaultSourcePaths());
          json(200, dataset);
        } catch (error) { json(400, { error: error.message }); }
        finally { importing = false; }
        return;
      }
      json(404, { error: 'Локальный API не найден.' }); return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end('Метод не поддерживается');
      return;
    }
    const file = FILES.get(pathname);
    if (!file) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Не найдено');
      return;
    }
    try {
      const contents = await readFile(path.join(ROOT, file[0]));
      response.writeHead(200, { 'Content-Type': file[1], 'Content-Length': contents.length });
      response.end(request.method === 'HEAD' ? undefined : contents);
    } catch {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Не удалось прочитать файл приложения');
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT должен быть целым числом от 1 до 65535');
  const server = createAppServer();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE'
      ? `Порт ${port} занят. Задайте другой PORT или остановите предыдущий сервер.`
      : `Не удалось запустить сервер: ${error.message}`);
    process.exitCode = 1;
  });
  loadLocalEnv().then(() => server.listen(port, '127.0.0.1', () => console.log(`Электрокомплект · HackAlem AI — http://127.0.0.1:${port}`))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
