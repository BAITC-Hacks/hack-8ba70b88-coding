/** Deterministic, fully fictional data. No external service or personal data. */
const DAY_MS = 86_400_000;

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4_294_967_296;
  };
}

function normalizedSeasonality(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / 12;
  return values.map((value) => value / mean);
}

function isStockout(productId, warehouseId, date) {
  const windows = [
    ['cable-vvg', 'wh-north', '2024-07-03', '2024-07-14'],
    ['cable-vvg', 'wh-north', '2025-07-03', '2025-07-18'],
    ['cable-vvg', 'wh-north', '2026-09-04', '2026-09-15'],
    ['cable-pvs', 'wh-south', '2025-06-10', '2025-06-20'],
    ['breaker-16', 'wh-north', '2026-08-01', '2026-08-14'],
    ['breaker-16', 'wh-north', '2025-11-10', '2025-11-18'],
    ['socket', 'wh-south', '2026-09-01', '2026-09-12'],
    ['led-panel', 'wh-north', '2026-02-08', '2026-02-18'],
    ['heater', 'wh-south', '2025-12-01', '2025-12-15'],
  ];
  return windows.some(([product, warehouse, start, end]) => (
    productId === product && warehouseId === warehouse && date >= start && date <= end
  ));
}

export function createDemoData() {
  const random = seededRandom(20260923);
  const historyStart = '2024-01-01';
  const asOf = '2026-09-23';
  const categories = [
    {
      id: 'cables', name: 'Кабельная продукция', reviewDays: 14, safetyDays: 7,
      seasonality: normalizedSeasonality([0.55, 0.6, 0.8, 1.05, 1.4, 1.65, 1.7, 1.55, 1.2, 0.95, 0.7, 0.55]),
    },
    {
      id: 'installation', name: 'Электроустановочные изделия', reviewDays: 14, safetyDays: 5,
      seasonality: normalizedSeasonality([0.75, 0.8, 0.95, 1.0, 1.05, 1.1, 1.1, 1.15, 1.25, 1.15, 0.95, 0.75]),
    },
    {
      id: 'lighting-heat', name: 'Освещение и обогрев', reviewDays: 21, safetyDays: 10,
      seasonality: normalizedSeasonality([1.55, 1.4, 1.1, 0.8, 0.65, 0.55, 0.55, 0.65, 0.9, 1.25, 1.5, 1.65]),
    },
  ];
  const warehouses = [
    { id: 'wh-north', name: 'Демо-склад «Север»' },
    { id: 'wh-south', name: 'Демо-склад «Юг»' },
  ];
  const suppliers = [
    { id: 'supplier-a', name: 'Демо-поставщик «Кабель»' },
    { id: 'supplier-b', name: 'Демо-поставщик «Монтаж»' },
    { id: 'supplier-c', name: 'Демо-поставщик «Свет»' },
  ];
  const products = [
    { id: 'cable-vvg', name: 'Кабель ВВГ 3×2,5 (демо)', categoryId: 'cables', supplierId: 'supplier-a', leadTimeDays: 12, packSize: 50, unit: 'м' },
    { id: 'cable-pvs', name: 'Провод ПВС 2×1,5 (демо)', categoryId: 'cables', supplierId: 'supplier-a', leadTimeDays: 18, packSize: 25, unit: 'м' },
    { id: 'breaker-16', name: 'Автоматический выключатель 16 А (демо)', categoryId: 'installation', supplierId: 'supplier-b', leadTimeDays: 10, packSize: 12, unit: 'шт.' },
    { id: 'breaker-32', name: 'Автоматический выключатель 32 А (демо)', categoryId: 'installation', supplierId: 'supplier-b', leadTimeDays: 16, packSize: 6, unit: 'шт.' },
    { id: 'switch', name: 'Выключатель одноклавишный (демо)', categoryId: 'installation', supplierId: 'supplier-b', leadTimeDays: 8, packSize: 10, unit: 'шт.' },
    { id: 'socket', name: 'Розетка с заземлением (демо)', categoryId: 'installation', supplierId: 'supplier-b', leadTimeDays: 14, packSize: 10, unit: 'шт.' },
    { id: 'led-panel', name: 'Светодиодная панель 36 Вт (демо)', categoryId: 'lighting-heat', supplierId: 'supplier-c', leadTimeDays: 25, packSize: 4, unit: 'шт.' },
    { id: 'heater', name: 'Конвектор 1,5 кВт (демо)', categoryId: 'lighting-heat', supplierId: 'supplier-c', leadTimeDays: 30, packSize: 2, unit: 'шт.' },
  ];
  // Deliberately varied stock: shortage, near depletion, and comfortable excess.
  const stock = [[12, 220], [90, 380], [0, 85], [65, 12], [900, 160], [75, 0], [14, 60], [4, 95]];
  const inventory = products.flatMap((product, productIndex) => warehouses.map((warehouse, warehouseIndex) => ({
    productId: product.id,
    warehouseId: warehouse.id,
    onHand: stock[productIndex][warehouseIndex],
  })));
  const baseDailyDemand = [8.5, 7, 5.5, 3.8, 6.2, 7.5, 2.4, 1.6];
  const sales = [];
  const availability = [];
  const startTime = Date.parse(`${historyStart}T00:00:00Z`);
  const endTime = Date.parse(`${asOf}T00:00:00Z`);
  for (let time = startTime, dayIndex = 0; time < endTime; time += DAY_MS, dayIndex += 1) {
    const dateObject = new Date(time);
    const date = dateObject.toISOString().slice(0, 10);
    const month = dateObject.getUTCMonth();
    const weekday = dateObject.getUTCDay();
    const growth = 1.14 ** (dayIndex / 365.25);
    for (const [productIndex, product] of products.entries()) {
      const category = categories.find((item) => item.id === product.categoryId);
      for (const [warehouseIndex, warehouse] of warehouses.entries()) {
        const pair = { productId: product.id, warehouseId: warehouse.id };
        const inStock = !isStockout(product.id, warehouse.id, date);
        availability.push({ date, ...pair, inStock });
        // Draw even on stockout days so latent demand uses the same random stream.
        const noise = 0.72 + random() * 0.56;
        const expected = baseDailyDemand[productIndex] * (warehouseIndex === 0 ? 1 : 0.75)
          * category.seasonality[month] * growth * (weekday === 0 ? 0.65 : 1) * noise;
        if (!inStock) continue;
        const quantity = Math.max(1, Math.round(expected));
        const first = Math.max(1, Math.floor(quantity * 0.6));
        sales.push({ date, ...pair, customerId: `anon-${productIndex + 1}-${warehouseIndex + 1}-a`, quantity: first });
        if (quantity > first) {
          sales.push({ date, ...pair, customerId: `anon-${productIndex + 1}-${warehouseIndex + 1}-b`, quantity: quantity - first });
        }
        // Recurrent large purchases are intentional normal demand.
        if (product.id === 'cable-vvg' && warehouse.id === 'wh-north' && weekday === 4) {
          sales.push({ date, ...pair, customerId: 'anon-regular-weekly', quantity: 80 });
        }
        if (product.id === 'led-panel' && warehouse.id === 'wh-south' && dateObject.getUTCDate() === 5) {
          sales.push({ date, ...pair, customerId: 'anon-regular-monthly', quantity: 120 });
        }
        // Split rows share a customer and a day: detection must aggregate them.
        if (product.id === 'breaker-16' && warehouse.id === 'wh-north' && date === '2026-07-20') {
          sales.push({ date, ...pair, customerId: 'anon-project-once', quantity: 350 });
          sales.push({ date, ...pair, customerId: 'anon-project-once', quantity: 275 });
        }
        if (product.id === 'breaker-32' && warehouse.id === 'wh-south' && date === '2026-09-03') {
          sales.push({ date, ...pair, customerId: 'anon-project-other', quantity: 800 });
        }
      }
    }
  }
  const inbound = [
    { productId: 'cable-vvg', warehouseId: 'wh-north', quantity: 150, eta: '2026-09-25' },
    { productId: 'cable-vvg', warehouseId: 'wh-north', quantity: 100, eta: '2026-10-12' },
    { productId: 'cable-pvs', warehouseId: 'wh-south', quantity: 200, eta: '2026-09-23' },
    { productId: 'breaker-16', warehouseId: 'wh-north', quantity: 72, eta: '2026-09-27' },
    { productId: 'breaker-32', warehouseId: 'wh-south', quantity: 60, eta: '2026-11-30' },
    { productId: 'socket', warehouseId: 'wh-south', quantity: 120, eta: '2026-10-14' },
    { productId: 'led-panel', warehouseId: 'wh-north', quantity: 80, eta: '2026-10-20' },
    { productId: 'heater', warehouseId: 'wh-north', quantity: 40, eta: '2026-09-18' },
  ];
  return {
    schemaVersion: 1,
    name: 'ДЕМОНСТРАЦИОННЫЙ набор «Электрокомплект»: вымышленные данные',
    isDemo: true,
    asOf,
    historyStart,
    categories,
    warehouses,
    suppliers,
    products,
    inventory,
    sales,
    availability,
    inbound,
    notes: [
      'Все организации, склады, товары, продажи и идентификаторы клиентов вымышлены; это демонстрационные, а не фактические данные ТОО «Электрокомплект».',
      'Постоянный seed 20260923. История с 01.01.2024 по 22.09.2026 включительно. Дата расчёта зафиксирована: 23.09.2026.',
      'Сезонные индексы категорий нормированы к среднему 1; в скрытый спрос заложен устойчивый рост 14% в год. Продажи имеют случайный шум и недельную составляющую.',
      'Доступность указана ежедневно для каждой пары товар/склад. На днях отсутствия товара продаж нет; скрытый спрос в данные продаж не включён.',
      'Разовые крупные продажи: breaker-16 / wh-north / 20.07.2026 — 350 + 275 одному клиенту; breaker-32 / wh-south / 03.09.2026 — 800.',
      'Регулярные крупные продажи: cable-vvg / wh-north — 80 каждый четверг при наличии; led-panel / wh-south — 120 пятого числа каждого месяца.',
      'Поставки включают прибытие в дату расчёта, в ближайшие дни, позднее срока нового заказа, за горизонтом планирования и просроченную поставку.',
      'История доступности показывает наличие для продажи в течение дня; текущий остаток — независимый снимок на дату расчёта, а не восстановленный товарный баланс.',
    ],
  };
}
