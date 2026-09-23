import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRecommendations } from '../src/engine.js';

const DAY = 86_400_000;
const iso = (time) => new Date(time).toISOString().slice(0, 10);
function fixture({ days = 180, asOf = '2026-07-01', daily = 10, onHand = 100, lead = 5, review = 10, safety = 2, pack = 1, seasonality = Array(12).fill(1), annual = 0 } = {}) {
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const result = {
    schemaVersion: 1, name: 'Тест', isDemo: true, asOf,
    historyStart: iso(end - days * DAY),
    categories: [{ id: 'c', name: 'Категория', reviewDays: review, safetyDays: safety, seasonality }],
    suppliers: [{ id: 's', name: 'Поставщик' }], warehouses: [{ id: 'w', name: 'Склад' }],
    products: [{ id: 'p', name: 'Товар', categoryId: 'c', supplierId: 's', leadTimeDays: lead, packSize: pack, unit: 'шт.' }],
    inventory: [{ productId: 'p', warehouseId: 'w', onHand }], sales: [], availability: [], inbound: [],
  };
  for (let offset = -days; offset < 0; offset++) {
    const time = end + offset * DAY;
    const date = iso(time);
    const quantity = daily * seasonality[new Date(time).getUTCMonth()] * (1 + annual / 100) ** (offset / 365);
    result.sales.push({ date, productId: 'p', warehouseId: 'w', customerId: 'retail', quantity });
    result.availability.push({ date, productId: 'p', warehouseId: 'w', inStock: true });
  }
  return result;
}
const calculate = (data, options) => calculateRecommendations(data, options).rows[0];
const near = (actual, expected, tolerance = 0.1) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≈ ${expected}`);

test('1: продажи, остаток, категория, срок, страховой запас и упаковка определяют заказ', () => {
  const data = fixture({ pack: 12 });
  const row = calculate(data);
  near(row.baseDailyDemand, 10);
  assert.equal(row.forecastDemand, 150);
  assert.equal(row.safetyStock, 20);
  assert.equal(row.requiredQuantity, 70);
  assert.equal(row.suggestedQuantity, 72);
  assert.equal(row.forecastDemandBeforeArrival, 50);
  assert.equal(row.urgency, 'soon');
  assert.match(row.explanation, /спрос 150 \+ буфер 20 − остаток 100/);
  data.categories[0].reviewDays = 20;
  assert.equal(calculate(data).forecastDemand, 250);
});

test('1: ETA внутри горизонта учитывается по дням, поздняя поставка не скрывает ранний дефицит', () => {
  const data = fixture({ onHand: 50, lead: 2, review: 8, safety: 0 });
  data.inbound.push({ productId: 'p', warehouseId: 'w', quantity: 100, eta: '2026-07-09' });
  const row = calculate(data);
  assert.equal(row.inboundOnTime, 100);
  assert.equal(row.requiredQuantity, 30);
  assert.equal(row.timingShortfall, 30);
  assert.equal(row.bottleneckDate, '2026-07-08');
  data.inbound[0].eta = '2026-07-04';
  assert.equal(calculate(data).suggestedQuantity, 0);
  data.inbound[0].eta = '2026-07-11'; // exclusive horizon boundary
  assert.equal(calculate(data).inboundLate, 100);
  assert.equal(calculate(data).suggestedQuantity, 50);
});

test('1: последний день горизонта включён, просроченный путь не считается поступившим', () => {
  const data = fixture({ onHand: 100, safety: 0 });
  data.inbound.push({ productId: 'p', warehouseId: 'w', quantity: 50, eta: '2026-07-15' });
  assert.equal(calculate(data).inboundOnTime, 50);
  assert.equal(calculate(data).suggestedQuantity, 40); // deficit before July 15 remains
  data.inbound[0].eta = '2026-06-30';
  const row = calculate(data);
  assert.equal(row.inboundOnTime, 0);
  assert.equal(row.inboundLate, 50);
  assert.equal(row.suggestedQuantity, 50);
  assert.match(row.warnings.join(' '), /Просрочено/);
});

test('1: спрос до срока нового заказа считается потерянным, а не накопленным долгом', () => {
  const data = fixture({ onHand: 0, lead: 5, review: 10, safety: 0 });
  let row = calculate(data);
  assert.equal(row.preArrivalShortfall, 50);
  assert.equal(row.suggestedQuantity, 100);
  assert.equal(row.urgency, 'critical');
  assert.equal(row.stockoutDate, '2026-07-01');
  assert.match(row.warnings.join(' '), /требуется ускорение/);
  data.inbound.push({ productId: 'p', warehouseId: 'w', quantity: 70, eta: '2026-07-03' });
  row = calculate(data);
  assert.equal(row.preArrivalShortfall, 20);
  assert.equal(row.suggestedQuantity, 60);
});

test('2: сезонность очищает историю и применяется к прогнозу; не становится ростом', () => {
  const factors = [0.5, 0.5, 0.5, 0.5, 1, 1, 2, 2, 1, 1, 1, 1];
  const row = calculate(fixture({ days: 540, daily: 10, seasonality: factors, onHand: 0 }));
  near(row.annualGrowthPct, 0, 0.001);
  near(row.baseDailyDemand, 10, 0.001);
  assert.equal(row.forecastDemand, 300);
});

test('2: устойчивый рост восстанавливается, ручной прирост заменяет автоматический', () => {
  const data = fixture({ days: 365, annual: 40, daily: 10 });
  const automatic = calculate(data);
  near(automatic.annualGrowthPct, 40, 0.05);
  near(automatic.baseDailyDemand, 10, 0.005);
  const manual = calculate(data, { growthMode: 'manual', annualGrowthPct: 40 });
  near(manual.forecastDemand, automatic.forecastDemand, 0.05);
  near(manual.baseDailyDemand, automatic.baseDailyDemand, 0.005);
  assert.equal(manual.annualGrowthPct, 40);
  const zero = calculate(data, { growthMode: 'manual', annualGrowthPct: 0 });
  assert.equal(zero.annualGrowthPct, 0);
  assert.ok(zero.forecastDemand < manual.forecastDemand);
  assert.match(manual.explanation, /вместо тренда/);
});

test('2: сезонность и рост одновременно восстанавливаются без двойного применения', () => {
  const seasonality = [0.5, 0.5, 0.5, 0.5, 1, 1, 2, 2, 1, 1, 1, 1];
  const data = fixture({ days: 730, annual: 40, seasonality, daily: 10 });
  const automatic = calculate(data);
  const manual = calculate(data, { growthMode: 'manual', annualGrowthPct: 40 });
  near(automatic.annualGrowthPct, 40, 0.05);
  near(automatic.baseDailyDemand, 10, 0.005);
  near(automatic.forecastDemand, manual.forecastDemand, 0.05);
  near(automatic.forecastDemand, Array.from({ length: 15 }, (_, day) => 20 * 1.4 ** (day / 365)).reduce((a, b) => a + b, 0), 0.05);
});

test('невалидный ручной сценарий отклоняется даже при пустой выборке', () => {
  for (const annualGrowthPct of [Infinity, NaN, '20', -91, 201, undefined]) {
    assert.throws(() => calculateRecommendations(fixture(), { warehouseId: 'missing', growthMode: 'manual', annualGrowthPct }), /прирост/);
  }
  assert.throws(() => calculate(fixture(), { growthMode: 'unknown' }), /режим/);
});

test('3: дни отсутствия восстанавливаются без повторного добавления к среднему спросу', () => {
  const data = fixture({ days: 140, daily: 10 });
  const outDates = new Set(data.availability.slice(40, 60).map((item) => item.date));
  data.availability.forEach((item) => { if (outDates.has(item.date)) item.inStock = false; });
  data.sales = data.sales.filter((item) => !outDates.has(item.date));
  const row = calculate(data);
  assert.equal(row.stockoutDays, 20);
  near(row.lostDemand, 200);
  near(row.baseDailyDemand, 10);
  near(row.forecastDemand, 150);
});

test('3: нулевые продажи при наличии сохраняются в знаменателе; отсутствие истории даёт предупреждение', () => {
  const data = fixture({ days: 140 });
  data.sales = data.sales.filter((_, index) => index % 2 === 0);
  near(calculate(data, { growthMode: 'manual', annualGrowthPct: 0 }).baseDailyDemand, 5);
  data.availability.forEach((item) => { item.inStock = false; });
  data.sales = [];
  const row = calculate(data);
  assert.equal(row.suggestedQuantity, 0);
  assert.match(row.warnings.join(' '), /Нет дней подтверждённого наличия/);
});

test('4: разовая крупная продажа одному клиенту исключается после агрегации нескольких строк', () => {
  const data = fixture();
  for (let index = 0; index < 4; index++) data.sales.push({ ...data.sales[80], customerId: 'project', quantity: 100 });
  const row = calculate(data);
  assert.equal(row.outlierCount, 1);
  assert.equal(row.outlierQuantity, 400);
  near(row.baseDailyDemand, 10);
  assert.equal(row.excludedOutliers[0].customerId, 'project');
});

test('4: регулярные крупные покупки сохраняются, чрезвычайный заказ того же клиента исключается', () => {
  const data = fixture({ days: 182 });
  for (let index = 0; index < 182; index += 7) data.sales.push({ ...data.sales[index], customerId: 'regular-bulk', quantity: 100 });
  data.sales.push({ ...data.sales[181], customerId: 'regular-bulk', quantity: 1000 });
  const row = calculate(data, { growthMode: 'manual', annualGrowthPct: 0 });
  assert.equal(row.outlierCount, 1);
  assert.equal(row.outlierQuantity, 1000);
  assert.equal(row.recurringBulkCount, 26);
  assert.ok(row.baseDailyDemand > 23 && row.baseDailyDemand < 25);
});

test('5: рекомендации группируются поставщиком, фильтруются по складу/категории и содержат объяснение', () => {
  const data = fixture();
  data.suppliers.push({ id: 'a', name: 'Альфа' });
  data.categories.push({ ...data.categories[0], id: 'c2', name: 'Другая' });
  data.warehouses.push({ id: 'w2', name: 'Второй' });
  data.products.push({ ...data.products[0], id: 'p2', name: 'Другой', supplierId: 'a', categoryId: 'c2' });
  data.inventory.push({ productId: 'p2', warehouseId: 'w2', onHand: 0 });
  data.sales.push(...data.sales.map((item) => ({ ...item, productId: 'p2', warehouseId: 'w2' })));
  data.availability.push(...data.availability.map((item) => ({ ...item, productId: 'p2', warehouseId: 'w2' })));
  const result = calculateRecommendations(data);
  assert.deepEqual(result.rows.map((row) => row.supplierName), ['Альфа', 'Поставщик']);
  assert.equal(result.summary.supplierCount, 2);
  assert.equal(result.summary.criticalCount, 1);
  assert.equal(calculateRecommendations(data, { warehouseId: 'w' }).rows.length, 1);
  assert.equal(calculateRecommendations(data, { categoryId: 'c2' }).rows[0].productId, 'p2');
  assert.equal(calculateRecommendations(data, { warehouseId: 'w', categoryId: 'c2' }).rows.length, 0);
  for (const row of result.rows) {
    assert.ok(row.explanation.length > 100);
    assert.ok(Number.isFinite(row.suggestedQuantity));
  }
});

test('ядро детерминировано, не изменяет вход; короткая история и ручное снижение безопасны', () => {
  const data = fixture({ days: 10 });
  const before = JSON.stringify(data);
  assert.deepEqual(calculateRecommendations(data), calculateRecommendations(data));
  assert.equal(JSON.stringify(data), before);
  assert.match(calculate(data).warnings.join(' '), /8 недель/);
  const row = calculate(data, { growthMode: 'manual', annualGrowthPct: -50 });
  assert.equal(row.annualGrowthPct, -50);
  assert.ok(Number.isFinite(row.suggestedQuantity));
  assert.throws(() => calculate(data, { growthMode: 'manual', annualGrowthPct: -100 }), /больше/);
});
