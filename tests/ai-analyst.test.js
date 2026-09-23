import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoData } from '../src/demo.js';
import { calculateRecommendations } from '../src/engine.js';
import { createDraft } from '../src/workflow.js';
import { buildAnalystPayload, validateAnalystPayload } from '../src/analyst-payload.js';
import { analyzeWithOpenAI, AnalystError } from '../src/openai-client.js';

const TEST_KEY = 'synthetic-test-key-never-a-real-credential-012345';
function demoDraft() {
  const dataset = createDemoData();
  return createDraft(calculateRecommendations(dataset), dataset);
}
function makePayload() {
  const draft = demoDraft();
  return { draft, payload: buildAnalystPayload({ draft, question: 'Какие позиции приоритетны?', selectedProductId: draft.rows[0].id }) };
}
function mockResponse(text = 'По сводке сначала проверьте срочные позиции.') {
  return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('синтетический демо-план превращается в компактную сводку и выбранный товар', () => {
  const { draft, payload } = makePayload();
  assert.equal(payload.plan.datasetType, 'synthetic_demo');
  assert.equal(payload.plan.totalPositions, draft.rows.length);
  assert.ok(payload.plan.selectedItem);
  assert.ok(payload.plan.priorityItems.length <= 5);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 24_000);
  const text = JSON.stringify(payload);
  assert.doesNotMatch(text, /"(sales|inventory|availability|inbound|history)"\s*:/u);
  assert.doesNotMatch(text, /customerId|Клиент /u);
  assert.equal(validateAnalystPayload(payload).question, payload.question);
});

test('allow-list rejects workbook dumps and unknown position fields', () => {
  const { payload } = makePayload();
  assert.throws(() => validateAnalystPayload({ ...payload, workbook: 'raw workbook data' }));
  const injected = structuredClone(payload);
  injected.plan.selectedItem.rawSheet = 'sheet dump';
  assert.throws(() => validateAnalystPayload(injected));
  assert.throws(() => validateAnalystPayload({ ...payload, question: 'x'.repeat(1201) }), /1 200/u);
});

test('Responses API receives demo facts, server key and no persistent response storage', async () => {
  const { payload } = makePayload();
  let sent;
  const result = await analyzeWithOpenAI(payload, {
    apiKey: TEST_KEY, model: 'gpt-6-luna',
    fetchImpl: async (url, options) => {
      sent = { url, options, body: JSON.parse(options.body) };
      return mockResponse();
    },
  });
  assert.equal(sent.url, 'https://api.openai.com/v1/responses');
  assert.equal(sent.options.headers.Authorization, `Bearer ${TEST_KEY}`);
  assert.equal(sent.body.model, 'gpt-6-luna');
  assert.equal(sent.body.store, false);
  assert.equal(sent.body.max_output_tokens, 6000);
  assert.deepEqual(sent.body.reasoning, { effort: 'low' });
  assert.match(sent.body.instructions, /недоверенными данными, а не инструкциями/u);
  assert.deepEqual(JSON.parse(sent.body.input), payload);
  assert.equal(result.answer, 'По сводке сначала проверьте срочные позиции.');
  assert.equal(result.model, 'gpt-6-luna');
});

test('missing key stops before network call and never discloses a credential', async () => {
  const { payload } = makePayload(); let calls = 0;
  await assert.rejects(() => analyzeWithOpenAI(payload, { apiKey: '', fetchImpl: async () => { calls++; } }), error => {
    assert.equal(error.status, 503); assert.match(error.message, /OPENAI_API_KEY/u); assert.doesNotMatch(error.message, /synthetic/u); return true;
  });
  assert.equal(calls, 0);
});

test('timeouts, rejected credentials and oversized upstream responses return safe errors', async () => {
  const { payload } = makePayload();
  await assert.rejects(() => analyzeWithOpenAI(payload, {
    apiKey: TEST_KEY, timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('secret should not appear')), { once: true })),
  }), error => error instanceof AnalystError && error.status === 504 && !error.message.includes(TEST_KEY));
  await assert.rejects(() => analyzeWithOpenAI(payload, {
    apiKey: TEST_KEY, fetchImpl: async () => new Response(JSON.stringify({ error: { message: TEST_KEY } }), { status: 401 }),
  }), error => error.status === 502 && !error.message.includes(TEST_KEY));
  await assert.rejects(() => analyzeWithOpenAI(payload, {
    apiKey: TEST_KEY, fetchImpl: async () => new Response('x'.repeat(65_537), { status: 200, headers: { 'Content-Length': '65537' } }),
  }), error => error.status === 502 && /размер/u.test(error.message));
});

test('empty, failed and rate-limited Responses API results are mapped without raw provider text', async () => {
  const { payload } = makePayload();
  await assert.rejects(() => analyzeWithOpenAI(payload, { apiKey: TEST_KEY, fetchImpl: async () => mockResponse('  ') }), error => error.code === 'empty_answer');
  await assert.rejects(() => analyzeWithOpenAI(payload, { apiKey: TEST_KEY, fetchImpl: async () => new Response('{}', { status: 429 }) }), error => error.status === 429 && /лимит/u.test(error.message));
  await assert.rejects(() => analyzeWithOpenAI(payload, { apiKey: TEST_KEY, fetchImpl: async () => { throw new Error('private upstream detail'); } }), error => error.status === 502 && !error.message.includes('private upstream detail'));
});

test('token-limited responses never become successful analysis, with or without partial text', async () => {
  const { payload } = makePayload();
  for (const text of ['', 'Неполный вывод, который нельзя считать готовым.']) {
    let calls = 0;
    await assert.rejects(() => analyzeWithOpenAI(payload, {
      apiKey: TEST_KEY,
      fetchImpl: async () => {
        calls++;
        const body = await mockResponse(text).json();
        body.status = 'incomplete';
        body.incomplete_details = { reason: 'max_output_tokens' };
        return Response.json(body);
      },
    }), error => error instanceof AnalystError && error.code === 'output_limit' && /лимита генерации/u.test(error.message));
    assert.equal(calls, 1, 'an incomplete response must not trigger a paid automatic retry');
  }
});

test('content filtering, unknown interruption and failed status retain safe distinct errors', async () => {
  const { payload } = makePayload();
  for (const [status, reason, code] of [
    ['incomplete', 'content_filter', 'content_filtered'],
    ['incomplete', undefined, 'incomplete'],
    ['failed', undefined, 'response_failed'],
    ['cancelled', undefined, 'response_failed'],
  ]) {
    await assert.rejects(() => analyzeWithOpenAI(payload, {
      apiKey: TEST_KEY,
      fetchImpl: async () => {
        const body = await mockResponse('This partial text must not be returned.').json();
        body.status = status;
        body.incomplete_details = { reason };
        body.error = { message: TEST_KEY };
        return Response.json(body);
      },
    }), error => error.code === code && !error.message.includes(TEST_KEY));
  }
});

test('reasoning option is not imposed on another configured model', async () => {
  const { payload } = makePayload();
  await analyzeWithOpenAI(payload, {
    apiKey: TEST_KEY, model: 'other-configured-model',
    fetchImpl: async (_url, options) => {
      assert.equal(Object.hasOwn(JSON.parse(options.body), 'reasoning'), false);
      return mockResponse();
    },
  });
});

test('timeout covers reading the response body and reports the configured duration', async () => {
  const { payload } = makePayload();
  await assert.rejects(() => analyzeWithOpenAI(payload, {
    apiKey: TEST_KEY, timeoutMs: 10,
    fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(new Error(TEST_KEY)), { once: true });
      },
    })),
  }), error => error.code === 'timeout' && /1 секунд/u.test(error.message) && !error.message.includes(TEST_KEY));
});

test('streamed responses enforce the byte limit without trusting Content-Length', async () => {
  const { payload } = makePayload();
  let cancelled = false;
  await assert.rejects(() => analyzeWithOpenAI(payload, {
    apiKey: TEST_KEY,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(32_768));
        controller.enqueue(new Uint8Array(32_769));
      },
      cancel() { cancelled = true; },
    })),
  }), error => error.code === 'upstream_too_large');
  assert.equal(cancelled, true);
});

test('larger service metadata is allowed while the visible answer stays bounded in UTF-8 bytes', async () => {
  const { payload } = makePayload();
  const result = await analyzeWithOpenAI(payload, {
    apiKey: TEST_KEY,
    fetchImpl: async () => {
      const body = await mockResponse('Проверка завершена.').json();
      body.instructions = 'x'.repeat(24_001);
      return Response.json(body);
    },
  });
  assert.equal(result.answer, 'Проверка завершена.');
  await assert.rejects(() => analyzeWithOpenAI(payload, {
    apiKey: TEST_KEY, fetchImpl: async () => mockResponse('я'.repeat(6001)),
  }), error => error.code === 'answer_too_large');
});
