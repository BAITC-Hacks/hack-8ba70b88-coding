import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoData } from '../src/demo.js';
import { validateDataset } from '../src/validation.js';
import { calculateRecommendations } from '../src/engine.js';
import { createDraft, updateQuantity, approveDraft, exportDraftCsv } from '../src/workflow.js';

test('демо: все обязательные сигналы распознаются вместе, результаты конечны', () => {
  const dataset = validateDataset(createDemoData());
  const { rows, summary } = calculateRecommendations(dataset);
  assert.equal(rows.length, 16);
  assert.equal(summary.supplierCount, 3);
  const find = (product, warehouse) => rows.find(row => row.productId === product && row.warehouseId === warehouse);
  assert.equal(find('breaker-16', 'wh-north').outlierQuantity, 625, 'split invoices aggregate to one outlier');
  assert.equal(find('breaker-16', 'wh-north').outlierCount, 1);
  assert.equal(find('breaker-32', 'wh-south').outlierQuantity, 800);
  assert.equal(find('cable-vvg', 'wh-north').outlierCount, 0, 'weekly bulk retained');
  assert.equal(find('led-panel', 'wh-south').outlierCount, 0, 'monthly bulk retained through seasons');
  assert.equal(summary.totalOutlierCount, 2, 'only the two intended one-off customer orders excluded');
  assert.ok(find('cable-vvg', 'wh-north').lostDemand > 0);
  assert.ok(find('cable-pvs', 'wh-north').annualGrowthPct > 5);
  assert.ok(find('heater', 'wh-north').warnings.some(text => text.includes('Просрочено')));
  assert.ok(rows.some(row => row.urgency === 'critical'));
  assert.ok(rows.some(row => row.suggestedQuantity === 0));
  for (const row of rows) {
    for (const field of ['baseDailyDemand', 'forecastDemand', 'safetyStock', 'lostDemand', 'suggestedQuantity']) assert.ok(Number.isFinite(row[field]), `${row.id} ${field}`);
    assert.equal(row.suggestedQuantity % row.packSize, 0);
    assert.ok(row.explanation.includes('Горизонт'));
  }
});

test('полный сценарий импорта: JSON → проверка → фильтры → расчёт → коррекция → утверждение → CSV', () => {
  const imported = validateDataset(JSON.parse(JSON.stringify(createDemoData())));
  const options = { warehouseId: 'wh-north', categoryId: 'installation', growthMode: 'manual', annualGrowthPct: 15 };
  const calculation = calculateRecommendations(imported, options);
  assert.equal(calculation.rows.length, 4);
  assert.ok(calculation.rows.every(row => row.warehouseId === 'wh-north' && row.categoryId === 'installation'));
  assert.ok(calculation.rows.every(row => row.annualGrowthPct === 15));
  const draft = createDraft(calculation, imported, options);
  const row = draft.rows.find(item => item.suggestedQuantity > 0);
  assert.throws(() => exportDraftCsv(draft));
  updateQuantity(draft, row.id, row.quantity + row.packSize);
  approveDraft(draft);
  const csv = exportDraftCsv(draft);
  assert.equal(csv.split('\r\n').length, 6);
  assert.ok(csv.includes('Демонстрационный'));
  assert.ok(csv.includes('"Демо-склад «Север»"'));
  assert.ok(!csv.includes('"Демо-склад «Юг»"'));
  updateQuantity(draft, row.id, 0);
  assert.throws(() => exportDraftCsv(draft));
  approveDraft(draft); assert.ok(exportDraftCsv(draft).includes('"0"'));
});
