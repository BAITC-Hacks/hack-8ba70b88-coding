import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRealRecommendations } from '../src/real-engine.js';

const DAY = 86_400_000;
const day = date => Date.parse(`${date}T00:00:00Z`) / DAY;
const daysIn = (year, month) => (Date.UTC(year, month + 1, 1) - Date.UTC(year, month, 1)) / DAY;
const options = { assumptionsConfirmed: true, leadTimeDays: 5, reviewDays: 10, safetyDays: 2, seasonalityMode: 'none', growthMode: 'manual', annualGrowthPct: 0 };
const source = (sheet, row = 2) => ({ file: 'fictional.xlsx', sheet, row });
function fixture({ asOf = '2026-07-01', daily = 10, annual = 0, season = Array(12).fill(1), onHand = 100 } = {}) {
  const monthlySales = [];
  const detailMonthly = [];
  for (let offset = 0; offset < 24; offset++) {
    const date = new Date(Date.UTC(2024, 6 + offset, 1));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const monthKey = date.toISOString().slice(0, 7);
    const days = daysIn(year, month);
    const middle = date.getTime() / DAY + (days - 1) / 2;
    const quantity = daily * days * season[month] * (1 + annual / 100) ** ((middle - day(asOf)) / 365);
    monthlySales.push({ month: monthKey, quantity, source: source('Продажи', offset + 2) });
    detailMonthly.push({ month: monthKey, warehouseId: 'w', positive: quantity, negative: 0, returns: 0, corrections: 0, rows: 1, source: source('Динамика', offset + 2) });
  }
  return {
    schemaVersion: 2, isDemo: false, name: 'Вымышленный набор', asOf, historyStart: '2024-07-01',
    warehouses: [{ id: 'global', name: 'Совокупно — без распределения' }, { id: 'w', name: 'Учебный склад' }],
    categories: [{ id: 'c', name: 'Учебная категория' }],
    suppliers: [{ id: 's', name: 'Вымышленный поставщик', detailPeriod: { start: '2024-07-01', end: '2026-06-30' }, seasonalityYears: [2024, 2025].map(year => ({ year, values: season.map((factor, month) => factor * daysIn(year, month) * 100 * (year === 2025 ? 2 : 1)), source: source('Сезонность', year - 2020) })), warnings: [] }],
    products: [{ id: 's:p', supplierId: 's', code: '000001', article: 'EDU-001', name: 'Вымышленный товар', unit: 'шт.', categoryId: 'c',
      packSize: 12, moq: 0, packSource: source('Кратность'), moqSource: source('MOQ'), monthlySales, detailMonthly,
      stocks: [{ date: asOf, month: null, quantity: onHand, basis: 'free', reserve: 20, source: source('Остатки') }], inbound: [], warnings: [],
    }], report: {},
  };
}
const calculate = (data, overrides = {}) => calculateRealRecommendations(data, { ...options, ...overrides }).rows[0];
const near = (actual, expected, tolerance = 0.01) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≈ ${expected}`);

test('real: explicit assumptions and lead time are required; invalid settings rejected before calculation', () => {
  const data = fixture();
  assert.throws(() => calculateRealRecommendations(data), /Подтвердите/);
  assert.throws(() => calculateRealRecommendations(data, { assumptionsConfirmed: true }), /leadTimeDays/);
  for (const value of [NaN, Infinity, -1, '5', 731]) assert.throws(() => calculate(data, { leadTimeDays: value }), /leadTimeDays/);
  assert.throws(() => calculate(data, { annualGrowthPct: 201 }), /прирост/);
  assert.throws(() => calculate(data, { fallbackPackSize: 0 }), /fallbackPackSize/);
  assert.throws(() => calculate(data, { fallbackPackSize: 1.5 }), /целым/);
  assert.throws(() => calculate(data, { stockSnapshotDate: '2026-07-02' }), /позже/);
  assert.throws(() => calculate(data, { stockSnapshotDate: '2026-02-31' }), /дат/);
});

test('real: known free stock is used without deducting reserve; quantity has numerical explanation and provenance', () => {
  const row = calculate(fixture());
  assert.equal(row.onHand, 100);
  near(row.baseDailyDemand, 10);
  assert.equal(row.forecastDemand, 150);
  assert.equal(row.safetyStock, 20);
  assert.equal(row.requiredQuantity, 70);
  assert.equal(row.suggestedQuantity, 72);
  assert.equal(row.stockStatus, 'known');
  assert.equal(row.stockDate, '2026-07-01');
  assert.equal(row.sourceFacts.stock.reserve, 20);
  assert.equal(row.sourceFacts.salesMonths.length, 12);
  assert.ok(row.sources.some(item => item.sheet === 'Продажи'));
  assert.match(row.explanation, /спрос 150 \+ буфер 20 − остаток 100/);
  assert.match(row.warnings.join(' '), /резерв повторно не вычитается/);
});

test('real: unknown stock differs from confirmed zero; latest blank never silently carries older quantity', () => {
  const data = fixture({ onHand: 0 });
  assert.equal(calculate(data).onHand, 0);
  assert.equal(calculate(data).suggestedQuantity, 120);
  data.products[0].stocks = [
    { month: '2026-06', date: '2026-06-01', quantity: 1000, basis: 'opening' },
    { month: '2026-07', date: '2026-07-01', quantity: null, basis: 'opening' },
  ];
  const unknown = calculate(data, { allowStaleStock: true });
  assert.equal(unknown.onHand, null);
  assert.equal(unknown.suggestedQuantity, null);
  assert.equal(unknown.stockStatus, 'unknown');
  assert.match(unknown.blockedReason, /Последний снимок/);
  const assumed = calculate(data, { unknownStock: 'zero-assumption' });
  assert.equal(assumed.onHand, 0);
  assert.equal(assumed.stockStatus, 'assumed-zero');
  assert.match(assumed.explanation, /явное допущение 0/);
});

test('real: undated free stock needs explicit snapshot date and stale stock needs explicit acceptance', () => {
  const data = fixture();
  data.products[0].stocks[0].date = null;
  assert.match(calculate(data).blockedReason, /Дата снимка/);
  const known = calculate(data, { stockSnapshotDate: '2026-07-01' });
  assert.equal(known.onHand, 100);
  assert.equal(known.sourceFacts.stock.assumedDate, true);
  assert.match(calculate(data, { stockSnapshotDate: '2026-06-01' }).blockedReason, /устарел/);
  const stale = calculate(data, { stockSnapshotDate: '2026-06-01', allowStaleStock: true });
  assert.equal(stale.onHand, 100);
  assert.match(stale.warnings.join(' '), /старый снимок/);
});

test('real: undated monthly stock is not assigned a fabricated end-of-month date', () => {
  const data = fixture();
  data.products[0].stocks = [{ month: '2026-06', date: null, quantity: 40, basis: 'unknown-monthly' }];
  assert.equal(calculate(data).onHand, null);
  assert.match(calculate(data).blockedReason, /Дата снимка/);
  const explicit = calculate(data, { stockSnapshotDate: '2026-06-30' });
  assert.equal(explicit.onHand, 40);
  assert.equal(explicit.stockDate, '2026-06-30');
  assert.match(calculate(data, { stockSnapshotDate: '2026-07-01' }).blockedReason, /не относится к месяцу/);
});

test('real: MOQ and pack are separate and missing rules block unless explicit fallback is set', () => {
  const data = fixture({ onHand: 165 });
  data.products[0].moq = 25;
  const row = calculate(data);
  assert.equal(row.requiredQuantity, 5);
  assert.equal(row.suggestedQuantity, 36);
  assert.equal(row.moq, 25);
  assert.equal(row.packSize, 12);
  data.products[0].stocks[0].quantity = 1000;
  assert.equal(calculate(data).suggestedQuantity, 0, 'MOQ must not cause a needless order');
  data.products[0].packSize = null;
  assert.equal(calculate(data).suggestedQuantity, null);
  const fallback = calculate(data, { fallbackPackSize: 1 });
  assert.equal(fallback.sourceFacts.pack.assumed, true);
  data.products[0].moq = null;
  assert.equal(calculate(data, { fallbackPackSize: 1 }).suggestedQuantity, null);
  assert.equal(calculate(data, { fallbackPackSize: 1, fallbackMoq: 0 }).suggestedQuantity, 0);
});

test('real: purchase-unit conversion is blocked even with valid batch rules or global fallback', () => {
  const data = fixture();
  data.products[0].unitConversionRequired = true;
  data.products[0].unitConversionSource = source('Примечания к закупке', 7);
  let row = calculate(data);
  assert.equal(row.suggestedQuantity, null);
  assert.equal(row.quantity, null);
  assert.equal(row.urgency, 'blocked');
  assert.equal(row.unitConversionRequired, true);
  assert.match(row.blockedReason, /подтверждённого коэффициента/);
  assert.match(row.warnings.join(' '), /исключите строку/);
  assert.equal(row.sourceFacts.unitConversion.required, true);
  assert.equal(row.sourceFacts.unitConversion.supported, false);
  assert.deepEqual(row.sourceFacts.unitConversion.source, data.products[0].unitConversionSource);
  assert.ok(row.sources.some(item => item.sheet === 'Примечания к закупке'));
  data.products[0].packSize = null;
  data.products[0].moq = null;
  row = calculate(data, { fallbackPackSize: 1, fallbackMoq: 0, unknownStock: 'zero-assumption' });
  assert.equal(row.suggestedQuantity, null, 'global assumptions cannot bypass an unresolved unit conversion');
});

test('real: maximum document line is provenance only, never a client order or automatic exclusion', () => {
  const data = fixture();
  data.products[0].detailMonthly[0].maxLineQuantity = 100;
  data.products[0].detailMonthly[0].maxLineSource = source('Динамика', 100);
  data.products[0].detailMonthly[1].maxLineQuantity = 250;
  data.products[0].detailMonthly[1].maxLineSource = source('Динамика', 200);
  const row = calculate(data);
  assert.equal(row.sourceFacts.detailAdjustments.maxLineQuantity, 250);
  assert.equal(row.sourceFacts.detailAdjustments.maxLineSource.row, 200);
  assert.equal(row.outlierCount, 0);
  assert.deepEqual(row.excludedOutliers, []);
});

test('real: an inbound batch reduces demand only from arrival day; earlier deficit remains visible', () => {
  const data = fixture({ onHand: 50 });
  data.products[0].packSize = 1;
  data.products[0].inbound = [{ quantity: 100, eta: '2026-07-09', etaType: 'exact', source: source('В пути') }];
  const config = { leadTimeDays: 2, reviewDays: 8, safetyDays: 0 };
  let row = calculate(data, config);
  assert.equal(row.inboundOnTime, 100);
  assert.equal(row.requiredQuantity, 30);
  assert.equal(row.timingShortfall, 30);
  assert.equal(row.bottleneckDate, '2026-07-08');
  data.products[0].inbound[0].eta = '2026-07-04';
  assert.equal(calculate(data, config).suggestedQuantity, 0);
  data.products[0].inbound[0].eta = '2026-07-11';
  row = calculate(data, config);
  assert.equal(row.inboundOnTime, 0);
  assert.equal(row.inboundLate, 100);
  assert.equal(row.suggestedQuantity, 50);
});

test('real: unknown inbound year, overdue batch and conservative deadline are explicit', () => {
  const data = fixture();
  data.products[0].inbound = [
    { quantity: 40, eta: null, etaMonthDay: '07-03', etaType: 'year-missing' },
    { quantity: 20, eta: '2026-06-30', etaType: 'exact' },
    { quantity: 15, eta: '2026-07-05', etaType: 'deadline' },
  ];
  const row = calculate(data);
  assert.equal(row.inboundUnknown, 40);
  assert.equal(row.overdueInbound, 20);
  assert.equal(row.inboundOnTime, 15);
  assert.match(row.warnings.join(' '), /консервативно/);
  const explicit = calculate(data, { etaYear: 2026 });
  assert.equal(explicit.inboundOnTime, 55);
  assert.equal(explicit.sourceFacts.inbound[0].effectiveEta, '2026-07-03');
  assert.equal(explicit.sourceFacts.inbound[0].assumedYear, true);
  assert.equal(explicit.leadTimeDays, 5, 'existing ETA never estimates new order lead time');
});

test('real: global stock and batches are never allocated to an individual warehouse', () => {
  const data = fixture();
  data.products[0].inbound = [{ quantity: 500, eta: '2026-07-02', etaType: 'exact' }];
  assert.throws(() => calculate(data, { warehouseId: 'w' }), /подробные продажи/);
  assert.throws(() => calculate(data, { warehouseId: 'w', salesSource: 'detail' }), /разрез/);
  const settings = { warehouseId: 'w', salesSource: 'detail', confirmDetailScope: true };
  const row = calculate(data, settings);
  assert.equal(row.onHand, null);
  assert.equal(row.suggestedQuantity, null);
  assert.equal(row.inboundOnTime, 0);
  assert.equal(row.inboundUnknown, 500);
  const assumed = calculate(data, { ...settings, unknownStock: 'zero-assumption' });
  assert.equal(assumed.onHand, 0);
  assert.equal(assumed.inboundOnTime, 0);
});

test('real: monthly and detailed sales never add; negative corrections and returns stay separate', () => {
  const data = fixture();
  for (const record of data.products[0].detailMonthly) {
    record.positive *= 2; record.negative = -5; record.returns = 3; record.corrections = 2;
  }
  const monthly = calculate(data);
  const detailed = calculate(data, { salesSource: 'detail', confirmDetailScope: true });
  assert.equal(monthly.baseDailyDemand, 10);
  assert.equal(detailed.baseDailyDemand, 20);
  assert.equal(monthly.detailNegative, -120);
  assert.equal(monthly.returns, 72);
  assert.equal(monthly.corrections, 48);
  assert.equal(detailed.sourceFacts.salesMonths[0].negative, -5);
  data.products[0].monthlySales.at(-1).quantity = -30;
  const negative = calculate(data);
  assert.equal(negative.monthlyNegative, -30);
  assert.equal(negative.sourceFacts.salesMonths.at(-1).demandQuantity, 0);
  assert.ok(negative.baseDailyDemand > 0);
});

test('real: seasonality normalizes annual magnitude; completed years only; growth is not applied twice', () => {
  const season = [0.5, 0.5, 0.5, 0.5, 1, 1, 2, 2, 1, 1, 1, 1];
  const data = fixture({ season, annual: 40 });
  // Use non-leap-year shapes; doubling aggregate annual totals does not create trend.
  data.suppliers[0].seasonalityYears[0].values = data.suppliers[0].seasonalityYears[1].values.map(value => value / 2);
  data.suppliers[0].seasonalityYears[0].year = 2023;
  data.suppliers[0].seasonalityYears.push({ year: 2026, values: Array(12).fill(100000), source: source('Сезонность') });
  const auto = calculate(data, { growthMode: 'auto', seasonalityMode: 'supplier' });
  const manual = calculate(data, { annualGrowthPct: 40, seasonalityMode: 'supplier' });
  near(auto.annualGrowthPct, 40, 0.01);
  near(auto.forecastDemand, manual.forecastDemand, 0.02);
  near(auto.forecastDemand, Array.from({ length: 15 }, (_, index) => 20 * 1.4 ** (index / 365)).reduce((a, b) => a + b, 0), 0.02);
  assert.deepEqual(auto.sourceFacts.seasonality.years, [2023, 2025]);
  assert.match(auto.warnings.join(' '), /незавершённых/);
  assert.ok(calculate(data, { annualGrowthPct: 0, seasonalityMode: 'supplier' }).forecastDemand < auto.forecastDemand);
});

test('real: flat seasonal history does not become growth; robust trend resists a single large month', () => {
  const data = fixture({ annual: 40 });
  const before = calculate(data, { growthMode: 'auto' });
  data.products[0].monthlySales.at(-3).quantity *= 100;
  const after = calculate(data, { growthMode: 'auto' });
  near(before.annualGrowthPct, 40);
  near(after.annualGrowthPct, 40);
  assert.equal(after.outlierCount, 0, 'without customer IDs no sales are automatically removed');
  assert.ok(after.forecastDemand > before.forecastDemand, 'large quantity remains in demand history');
});

test('real: unfinished months are excluded unless explicitly included with elapsed days', () => {
  const data = fixture({ asOf: '2026-07-15' });
  data.products[0].monthlySales.push({ month: '2026-07', quantity: 140, source: source('Продажи', 30) });
  const excluded = calculate(data);
  assert.equal(excluded.trainingMonths, 12);
  assert.equal(excluded.sourceFacts.salesPeriod.end, '2026-06');
  const included = calculate(data, { includePartialMonth: true });
  assert.equal(included.trainingMonths, 13);
  assert.equal(included.sourceFacts.salesMonths.at(-1).days, 14);
  assert.equal(included.sourceFacts.salesMonths.at(-1).incomplete, true);
  assert.equal(included.baseDailyDemand, 10);
});

test('real: report partial first month is not treated as a full month of detail sales', () => {
  const data = fixture();
  data.suppliers[0].detailPeriod = { start: '2026-06-16', end: '2026-06-30' };
  data.products[0].detailMonthly = [{ month: '2026-06', warehouseId: 'w', positive: 150, negative: 0, returns: 0, corrections: 0 }];
  const settings = { salesSource: 'detail', confirmDetailScope: true };
  assert.equal(calculate(data, settings).suggestedQuantity, null);
  const included = calculate(data, { ...settings, includePartialMonth: true });
  assert.equal(included.trainingDays, 15);
  assert.equal(included.baseDailyDemand, 10);
});

test('real: monthly blank is unknown by default and only becomes zero through named assumption', () => {
  const data = fixture();
  data.products[0].monthlySales.at(-1).quantity = null;
  assert.equal(calculate(data).trainingMonths, 11);
  assert.equal(calculate(data).baseDailyDemand, 10);
  const zero = calculate(data, { monthlyBlanks: 'zero-assumption' });
  assert.equal(zero.trainingMonths, 12);
  assert.ok(zero.baseDailyDemand < 10);
  assert.equal(zero.sourceFacts.salesMonths.at(-1).assumedZero, true);
});

test('real: absent detail months remain unknown with warning; explicit zero assumption uses full declared monthly coverage', () => {
  const data = fixture();
  data.products[0].detailMonthly = data.products[0].detailMonthly.filter(record => record.month === '2026-06');
  const settings = { salesSource: 'detail', confirmDetailScope: true };
  const unknown = calculate(data, settings);
  assert.equal(unknown.trainingMonths, 1);
  assert.equal(unknown.baseDailyDemand, 10);
  assert.match(unknown.warnings.join(' '), /месяцев подробного отчёта: 11/);
  assert.match(unknown.warnings.join(' '), /может завышать/);
  const zeros = calculate(data, { ...settings, monthlyBlanks: 'zero-assumption' });
  assert.equal(zeros.trainingMonths, 12);
  near(zeros.baseDailyDemand, 300 / 365, 0.0001);
  assert.equal(zeros.sourceFacts.salesMonths.filter(record => record.assumedZero).length, 11);
});

test('real: monthly snapshots do not fabricate stockout days or client-specific outlier decisions', () => {
  const data = fixture({ onHand: 0 });
  const row = calculate(data);
  assert.equal(row.lostDemand, null);
  assert.equal(row.stockoutDays, null);
  assert.equal(row.observedInStockDays, null);
  assert.equal(row.outlierCount, 0);
  assert.equal(row.recurringBulkCount, null);
  assert.match(row.warnings.join(' '), /номер документа не считается клиентом/);
  assert.match(row.warnings.join(' '), /точные дни отсутствия/);
});

test('real: filters preserve supplier identity and every selected product without hidden truncation', () => {
  const data = fixture();
  data.suppliers.push({ ...data.suppliers[0], id: 's2', name: 'Другой поставщик' });
  const product = data.products[0];
  data.products = Array.from({ length: 1201 }, (_, index) => ({ ...product, id: `s:p${index}`, name: `Товар ${index}` }));
  data.products.push({ ...product, id: 's2:p', supplierId: 's2' });
  const result = calculateRealRecommendations(data, options);
  assert.equal(result.rows.length, 1202);
  assert.equal(result.summary.supplierCount, 2);
  assert.equal(calculateRealRecommendations(data, { ...options, supplierId: 's2' }).rows.length, 1);
  assert.equal(calculateRealRecommendations(data, { ...options, categoryId: 'missing' }).rows.length, 0);
  assert.notEqual(result.rows[0].id, result.rows.at(-1).id);
});

test('real: calculation is deterministic, does not mutate input, and blocked rows remain in summary', () => {
  const data = fixture();
  data.products[0].moq = null;
  const before = JSON.stringify(data);
  const result = calculateRealRecommendations(data, options);
  assert.deepEqual(result, calculateRealRecommendations(data, options));
  assert.equal(JSON.stringify(data), before);
  assert.equal(result.summary.blockedCount, 1);
  assert.equal(result.summary.rowCount, 1);
  assert.equal(result.summary.totalLostDemand, null);
});
