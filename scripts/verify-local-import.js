// Explicit local verification only. Never runs as part of the synthetic test suite.
// All resulting source-dependent files go to private-data/, excluded from Git.
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { defaultSourcePaths, importLocalSources } from '../src/local-import.js';
import { calculateRealRecommendations } from '../src/real-engine.js';
import { createDraft, updateQuantity, approveDraft, exportDraftCsv, setRowExcluded } from '../src/workflow.js';

const paths = defaultSourcePaths();
async function hashes() {
  const result = {};
  for (const [supplier, directory] of Object.entries(paths)) {
    for (const filename of (await readdir(directory)).filter(name => /\.xlsx$/i.test(name) && !name.startsWith('~$')).sort()) {
      result[`${supplier}/${filename}`] = createHash('sha256').update(await readFile(path.join(directory, filename))).digest('hex');
    }
  }
  return result;
}
const before = await hashes();
console.time('Импорт полного набора');
const dataset = await importLocalSources(paths);
console.timeEnd('Импорт полного набора');
assert.equal(dataset.report.fileCount, Object.keys(before).length);
assert.equal(new Set(dataset.products.map(product => product.id)).size, dataset.products.length);
const options = {
  warehouseId: 'global', categoryId: 'all', supplierId: 'all', growthMode: 'auto', annualGrowthPct: 0,
  leadTimeDays: 30, reviewDays: 14, safetyDays: 7, lookbackMonths: 12,
  seasonalityMode: 'supplier', stockMode: 'latest',
  stockSnapshotDate: new Date(Date.parse(dataset.asOf) - 86400000).toISOString().slice(0, 10),
  allowStaleStock: true, unknownStock: 'block', fallbackPackSize: 1, fallbackMoq: 0,
  etaYear: Number(dataset.asOf.slice(0, 4)), monthlyBlanks: 'unknown', salesSource: 'monthly',
  confirmDetailScope: false, includePartialMonth: false, assumptionsConfirmed: true,
};
console.time('Расчёт всех товаров');
const result = calculateRealRecommendations(dataset, options);
console.timeEnd('Расчёт всех товаров');
assert.equal(result.rows.length, dataset.products.length, 'Ни один товар не должен быть усечён');
assert.ok(result.rows.every(row => row.lostDemand == null), 'Месячные остатки не дают точный упущенный спрос');
const draft = createDraft(result, dataset, options);
const editable = draft.rows.find(row => row.quantity > 0 && row.packSize > 0);
assert.ok(editable, 'Есть рекомендация для проверки ручного редактирования');
updateQuantity(draft, editable.id, editable.quantity + editable.packSize);
for (const row of draft.rows) if (row.quantity == null) setRowExcluded(draft, row.id, true);
approveDraft(draft);
const csv = exportDraftCsv(draft);
assert.ok(csv.includes('Утверждённое количество'));
updateQuantity(draft, editable.id, editable.quantity + editable.packSize);
assert.throws(() => exportDraftCsv(draft));
approveDraft(draft);

const selected = dataset.products.find(product => product.id === editable.productId);
assert.ok(selected);
const one = { ...dataset, products: [structuredClone(selected)] };
const calc = (data = one, overrides = {}) => calculateRealRecommendations(data, { ...options, ...overrides }).rows[0];
const base = calc();
const abundant = structuredClone(one);
abundant.products[0].stocks = [{ quantity: 1e8, basis: 'free', date: options.stockSnapshotDate, month: null, reserve: 1e6, source: 'Проверочная модификация в памяти' }];
assert.equal(calc(abundant).suggestedQuantity, 0, 'Дополнительный свободный остаток уменьшает заказ');
assert.equal(calc(abundant).onHand, 1e8, 'Резерв повторно не вычитается из свободного остатка');
const arriving = structuredClone(one);
arriving.products[0].inbound = [{ quantity: 1e8, eta: dataset.asOf, etaType: 'exact', source: 'Проверочная партия в памяти' }];
assert.equal(calc(arriving).suggestedQuantity, 0, 'Подтверждённая партия в начале горизонта покрывает заказ');
const growth0 = calc(one, { growthMode: 'manual', annualGrowthPct: 0 });
const growth100 = calc(one, { growthMode: 'manual', annualGrowthPct: 100 });
assert.notEqual(growth0.forecastDemand, growth100.forecastDemand, 'Настройка роста влияет на прогноз');
const noSeason = calc(one, { seasonalityMode: 'none' });
assert.notEqual(base.forecastDemand, noSeason.forecastDemand, 'Сезонность влияет на прогноз');
const constrained = structuredClone(one);
constrained.products[0].packSize = 7; constrained.products[0].moq = 101;
const packed = calc(constrained);
assert.ok(packed.suggestedQuantity >= 101 && packed.suggestedQuantity % 7 === 0);

assert.deepEqual(await hashes(), before, 'Исходные Excel не изменились');
await mkdir(new URL('../private-data/', import.meta.url), { recursive: true });
await writeFile(new URL('../private-data/imported.json', import.meta.url), JSON.stringify(dataset));
await writeFile(new URL('../private-data/verified-plan.csv', import.meta.url), exportDraftCsv(draft));
const verification = {
  checkedAt: new Date().toISOString(), files: dataset.report.fileCount, products: dataset.products.length,
  suppliers: dataset.report.suppliers, assumptions: options, summary: result.summary,
  sourceHashesUnchanged: true,
  checks: ['полный импорт', 'отсутствие усечения товаров', 'остаток и резерв', 'поставки', 'сезонность', 'рост', 'MOQ и кратность', 'коррекция → утверждение → CSV → снятие утверждения', 'SHA256 исходников'],
  sample: { productId: editable.productId, before: base, manualQuantity: editable.quantity },
};
await writeFile(new URL('../private-data/verification.json', import.meta.url), JSON.stringify(verification, null, 2));
console.log(JSON.stringify({ files: verification.files, products: verification.products, suppliers: verification.suppliers, summary: verification.summary, checks: verification.checks }, null, 2));
