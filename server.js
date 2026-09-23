import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ...['app', 'engine', 'demo', 'validation', 'workflow'].map(name =>
    [`/src/${name}.js`, [`src/${name}.js`, 'text/javascript; charset=utf-8']]),
  ['/src/styles.css', ['src/styles.css', 'text/css; charset=utf-8']],
]);

export function createAppServer() {
  return http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end('Метод не поддерживается');
      return;
    }
    let pathname;
    try { pathname = new URL(request.url, 'http://localhost').pathname; }
    catch { response.writeHead(400).end('Некорректный адрес'); return; }
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
  server.listen(port, '127.0.0.1', () => console.log(`Электрокомплект · HackAlem AI — http://127.0.0.1:${port}`));
}
