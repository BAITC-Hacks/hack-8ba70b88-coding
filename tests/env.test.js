import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadLocalEnv } from '../src/env.js';

test('local .env loads simple quoted settings without replacing existing environment', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hackalem-env-'));
  const keyName = 'HACKALEM_ENV_TEST_VALUE';
  const secondName = 'HACKALEM_ENV_SECOND';
  const prior = process.env[keyName];
  const priorSecond = process.env[secondName];
  t.after(async () => {
    if (prior === undefined) delete process.env[keyName]; else process.env[keyName] = prior;
    if (priorSecond === undefined) delete process.env[secondName]; else process.env[secondName] = priorSecond;
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(path.join(directory, '.env'), '# local only\nHACKALEM_ENV_TEST_VALUE="synthetic value"\nHACKALEM_ENV_SECOND=demo # trailing note\n', 'utf8');
  delete process.env[keyName];
  assert.equal(await loadLocalEnv(directory), true);
  assert.equal(process.env[keyName], 'synthetic value');
  assert.equal(process.env[secondName], 'demo');
});

test('missing .env is an ordinary setup state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hackalem-env-empty-'));
  try { assert.equal(await loadLocalEnv(directory), false); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

test('example environment file is a placeholder, not a key', async () => {
  const example = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(example, /OPENAI_API_KEY=\s*$/mu);
  assert.match(example, /OPENAI_MODEL=gpt-6-luna/u);
});
