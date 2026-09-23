import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('модуль интерфейса проходит синтаксическую проверку Node.js', () => {
  const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL('../src/app.js', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
