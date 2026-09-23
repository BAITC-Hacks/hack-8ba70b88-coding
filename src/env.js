import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Load simple local KEY=value entries without overriding existing process environment. */
export async function loadLocalEnv(directory = process.cwd()) {
  let contents;
  try { contents = await readFile(path.join(directory, '.env'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw new Error('Не удалось прочитать локальный .env.'); }
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/u, '').trim();
    process.env[match[1]] = value;
  }
  return true;
}
