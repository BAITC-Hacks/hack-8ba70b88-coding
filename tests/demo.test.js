import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoData } from '../src/demo.js';

const data = createDemoData();
const pairKey = (row) => `${row.productId}|${row.warehouseId}`;
const dayKey = (row) => `${row.date}|${pairKey(row)}`;

test('демо-набор воспроизводим и явно помечен как вымышленный', () => {
  assert.deepEqual(createDemoData(), data);
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.isDemo, true);
  assert.match(data.name, /ДЕМОНСТРАЦИОННЫЙ/);
  assert.equal(data.products.length, 8);
  assert.equal(data.warehouses.length, 2);
  assert.equal(data.categories.length, 3);
  assert.equal(data.suppliers.length, 3);
  assert.ok(data.sales.every((row) => /^anon-/.test(row.customerId)));
});

test('наличие покрывает каждый день истории и продаж нет при отсутствии товара', () => {
  const days = (Date.parse(data.asOf) - Date.parse(data.historyStart)) / 86_400_000;
  assert.ok(days > 365 * 2);
  assert.equal(data.availability.length, days * data.inventory.length);
  const available = new Map(data.availability.map((row) => [dayKey(row), row.inStock]));
  assert.equal(available.size, data.availability.length, 'duplicate availability keys');
  const pairs = new Set(data.inventory.map(pairKey));
  for (const row of data.availability) {
    assert.ok(pairs.has(pairKey(row)));
    assert.ok(row.date >= data.historyStart && row.date < data.asOf);
  }
  for (const row of data.sales) {
    assert.equal(available.get(dayKey(row)), true, `sale during stockout: ${dayKey(row)}`);
    assert.ok(row.quantity > 0);
    assert.ok(row.date < data.asOf);
  }
  assert.ok(data.availability.some((row) => !row.inStock));
});

test('в демо представлены нормированная сезонность и устойчивый рост', () => {
  for (const category of data.categories) {
    assert.equal(category.seasonality.length, 12);
    assert.ok(category.seasonality.every((factor) => factor > 0));
    assert.ok(Math.abs(category.seasonality.reduce((sum, factor) => sum + factor, 0) / 12 - 1) < 1e-12);
  }
  const summer = data.categories.find((row) => row.id === 'cables').seasonality;
  const winter = data.categories.find((row) => row.id === 'lighting-heat').seasonality;
  assert.ok(summer[6] > summer[0] * 2);
  assert.ok(winter[0] > winter[6] * 2);
  const amount = (year) => data.sales
    .filter((row) => row.productId === 'cable-pvs' && row.warehouseId === 'wh-north'
      && row.date >= `${year}-01-01` && row.date < `${year}-07-01`)
    .reduce((sum, row) => sum + row.quantity, 0);
  assert.ok(amount('2026') > amount('2024') * 1.2);
});

test('есть разовые крупные заказы со split-транзакциями и регулярные крупные покупки', () => {
  const split = data.sales.filter((row) => row.customerId === 'anon-project-once');
  assert.equal(split.length, 2);
  assert.equal(split[0].date, split[1].date);
  assert.equal(pairKey(split[0]), pairKey(split[1]));
  assert.equal(split.reduce((sum, row) => sum + row.quantity, 0), 625);
  assert.equal(data.sales.filter((row) => row.customerId === 'anon-project-other').length, 1);
  const weekly = data.sales.filter((row) => row.customerId === 'anon-regular-weekly');
  const monthly = data.sales.filter((row) => row.customerId === 'anon-regular-monthly');
  assert.ok(weekly.length > 100);
  assert.ok(monthly.length >= 32);
  assert.ok(weekly.every((row) => row.quantity === 80 && new Date(row.date).getUTCDay() === 4));
  assert.ok(monthly.every((row) => row.quantity === 120 && row.date.endsWith('-05')));
});

test('демо поставок охватывает просрочку, разные ETA и прибытие за горизонтом', () => {
  assert.ok(data.inbound.some((row) => row.eta < data.asOf));
  assert.ok(data.inbound.some((row) => row.eta === data.asOf));
  assert.ok(data.inbound.some((row) => row.eta > data.asOf));
  assert.ok(data.inbound.some((row) => {
    const product = data.products.find((item) => item.id === row.productId);
    const category = data.categories.find((item) => item.id === product.categoryId);
    const horizon = product.leadTimeDays + category.reviewDays + category.safetyDays;
    return Date.parse(row.eta) - Date.parse(data.asOf) > horizon * 86_400_000;
  }));
});
