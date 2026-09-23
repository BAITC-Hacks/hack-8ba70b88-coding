import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDataset } from '../src/validation.js';
import { createDemoData } from '../src/demo.js';

test('демонстрационный набор соответствует строгой схеме', () => {
  const data = createDemoData();
  assert.equal(validateDataset(data), data);
});

for (const [name, change, error] of [
  ['пропущенный день наличия', d => d.availability.pop(), /все дни/],
  ['дублирование остатков', d => d.inventory.push({ ...d.inventory[0] }), /повторная пара/],
  ['отрицательный остаток', d => { d.inventory[0].onHand = -1; }, /число/],
  ['несуществующая дата', d => { d.asOf = '2026-02-30'; }, /несуществующая дата/],
  ['неизвестный поставщик', d => { d.products[0].supplierId = 'missing'; }, /неизвестный/],
  ['нулевой сезонный индекс', d => { d.categories[0].seasonality[0] = 0; }, /число/],
  ['отсутствующий идентификатор клиента', d => { delete d.sales[0].customerId; }, /customerId/],
  ['идентификатор склада конфликтует с фильтром', d => { d.warehouses[0].id = 'all'; }, /зарезервирован/],
  ['продажа в будущем', d => { d.sales[0].date = d.asOf; }, /вне истории/],
  ['строка вместо количества', d => { d.sales[0].quantity = '12'; }, /число/],
  ['дробная упаковка', d => { d.products[0].packSize = 1.5; }, /целое/],
  ['дублирование наличия', d => d.availability.push({ ...d.availability[0] }), /повторная доступность/],
  ['продажа в день отсутствия', d => {
    const sale = d.sales[0];
    d.availability.find(a => a.date === sale.date && a.productId === sale.productId && a.warehouseId === sale.warehouseId).inStock = false;
  }, /полного отсутствия/],
]) {
  test(`импорт отклоняет: ${name}`, () => {
    const data = createDemoData(); change(data);
    assert.throws(() => validateDataset(data), error);
  });
}

test('дни с наличием и нулевыми продажами допустимы', () => {
  const data = createDemoData(); data.sales = [];
  assert.equal(validateDataset(data), data);
});
