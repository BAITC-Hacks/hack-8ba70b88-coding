const DAY = 86_400_000;
function fail(message) { throw new Error(`Ошибка данных: ${message}`); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}: ожидается объект.`);
}
function string(value, label, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) fail(`${label}: нужна непустая строка до ${max} символов без управляющих символов.`);
}
function number(value, label, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(`${label}: нужно ${integer ? 'целое ' : ''}число от ${min} до ${max}.`);
}
function date(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label}: дата в формате YYYY-MM-DD.`);
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) fail(`${label}: несуществующая дата.`);
  return timestamp;
}
function array(value, label, max, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${label}: ожидается массив от ${min} до ${max} строк.`);
}
const pairKey = (productId, warehouseId) => JSON.stringify([productId, warehouseId]);
const dayKey = (productId, warehouseId, day) => JSON.stringify([productId, warehouseId, day]);

/** Strict input validation shared by imports and tests. No implied zero-stock dates. */
export function validateDataset(data) {
  object(data, 'набор');
  if (data.schemaVersion !== 1) fail('поддерживается только schemaVersion: 1.');
  string(data.name, 'name');
  if (typeof data.isDemo !== 'boolean') fail('isDemo должен быть true или false.');
  const start = date(data.historyStart, 'historyStart');
  const asOf = date(data.asOf, 'asOf');
  const days = (asOf - start) / DAY;
  if (days < 28 || days > 1830) fail('история должна содержать от 28 до 1830 дней до asOf.');
  const maps = {};
  for (const name of ['categories', 'warehouses', 'suppliers', 'products']) {
    array(data[name], name, 1000, 1);
    const map = new Map();
    data[name].forEach((row, index) => {
      const label = `${name}[${index + 1}]`;
      object(row, label); string(row.id, `${label}.id`, 80); string(row.name, `${label}.name`);
      if (['warehouses', 'categories'].includes(name) && row.id === 'all') fail(`${label}: id «all» зарезервирован для фильтра «Все».`);
      if (map.has(row.id)) fail(`${label}: повторный id «${row.id}».`);
      map.set(row.id, row);
    });
    maps[name] = map;
  }
  const reference = (map, id, label) => {
    if (!maps[map].has(id)) fail(`${label}: неизвестный идентификатор «${String(id).slice(0, 80)}».`);
  };
  for (const row of data.categories) {
    number(row.reviewDays, `${row.id}.reviewDays`, 1, 180, true);
    number(row.safetyDays, `${row.id}.safetyDays`, 0, 90, true);
    array(row.seasonality, `${row.id}.seasonality`, 12, 12);
    row.seasonality.forEach(x => number(x, `${row.id}.seasonality`, 0.1, 5));
    if (Math.abs(row.seasonality.reduce((a, b) => a + b, 0) / 12 - 1) > 0.03) fail(`${row.id}: среднее 12 индексов сезонности должно быть 1 (допуск 0,03).`);
  }
  for (const row of data.products) {
    reference('categories', row.categoryId, `${row.id}.categoryId`);
    reference('suppliers', row.supplierId, `${row.id}.supplierId`);
    number(row.leadTimeDays, `${row.id}.leadTimeDays`, 1, 180, true);
    number(row.packSize, `${row.id}.packSize`, 1, 1_000_000, true);
    string(row.unit, `${row.id}.unit`, 30);
  }
  array(data.inventory, 'inventory', 1000, 1);
  if (data.inventory.length * days > 200_000) fail('слишком много пар товар/склад × дней (максимум 200 000).');
  const pairs = new Set();
  const checkPair = (row, label, mustExist = true) => {
    object(row, label);
    reference('products', row.productId, `${label}.productId`);
    reference('warehouses', row.warehouseId, `${label}.warehouseId`);
    const key = pairKey(row.productId, row.warehouseId);
    if (mustExist && !pairs.has(key)) fail(`${label}: нет текущего остатка для пары товар/склад.`);
    return key;
  };
  data.inventory.forEach((row, i) => {
    const key = checkPair(row, `inventory[${i + 1}]`, false);
    number(row.onHand, `inventory[${i + 1}].onHand`, 0, 1e9);
    if (pairs.has(key)) fail('inventory: повторная пара товар/склад.');
    pairs.add(key);
  });
  array(data.availability, 'availability', 200_000, 1);
  const available = new Map();
  data.availability.forEach((row, i) => {
    const label = `availability[${i + 1}]`;
    checkPair(row, label);
    const time = date(row.date, `${label}.date`);
    if (time < start || time >= asOf) fail(`${label}: дата вне истории.`);
    if (typeof row.inStock !== 'boolean') fail(`${label}.inStock должен быть true или false.`);
    const key = dayKey(row.productId, row.warehouseId, row.date);
    if (available.has(key)) fail(`${label}: повторная доступность за день.`);
    available.set(key, row.inStock);
  });
  if (available.size !== pairs.size * days) fail('availability: нужны все дни истории для каждой пары товар/склад, включая дни без продаж.');
  array(data.sales, 'sales', 300_000);
  data.sales.forEach((row, i) => {
    const label = `sales[${i + 1}]`;
    checkPair(row, label);
    const time = date(row.date, `${label}.date`);
    if (time < start || time >= asOf) fail(`${label}: дата вне истории.`);
    string(row.customerId, `${label}.customerId`, 80);
    number(row.quantity, `${label}.quantity`, Number.MIN_VALUE, 1e9);
    if (!available.get(dayKey(row.productId, row.warehouseId, row.date))) fail(`${label}: продажа в день полного отсутствия товара; исправьте inStock или историю.`);
  });
  array(data.inbound, 'inbound', 10_000);
  data.inbound.forEach((row, i) => {
    const label = `inbound[${i + 1}]`;
    checkPair(row, label);
    date(row.eta, `${label}.eta`);
    number(row.quantity, `${label}.quantity`, Number.MIN_VALUE, 1e9);
  });
  return data;
}
