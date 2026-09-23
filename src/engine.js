/** Deterministic, dependency-free replenishment model. Dates are UTC calendar days. */
const DAY = 86_400_000;
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const sum = (values) => values.reduce((total, value) => total + value, 0);
const round = (value, digits = 2) => Math.round((value + Number.EPSILON) * 10 ** digits) / 10 ** digits;
const dayNumber = (date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY);
const dateString = (day) => new Date(day * DAY).toISOString().slice(0, 10);
const month = (day) => new Date(day * DAY).getUTCMonth();
const key = (productId, warehouseId) => JSON.stringify([productId, warehouseId]);
const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const positive = (value) => Math.max(0, finite(value));
const n = (value) => round(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 });

/** Aggregate BEFORE detection: a project split into invoices must remain one event. */
function cleanSales(sales, category, start, asOf, available) {
  const events = new Map();
  for (const sale of sales) {
    const day = dayNumber(sale.date);
    if (day < start || day >= asOf || !positive(sale.quantity)) continue;
    const eventKey = JSON.stringify([sale.date, sale.customerId]);
    const event = events.get(eventKey) || { date: sale.date, day, customerId: sale.customerId, quantity: 0 };
    event.quantity += positive(sale.quantity);
    events.set(eventKey, event);
  }
  const factors = category.seasonality;
  const orders = [...events.values()].map((event) => ({
    ...event, normalized: event.quantity / factors[month(event.day)],
  }));
  const daily = new Map();
  const customers = new Map();
  for (const event of orders) {
    daily.set(event.day, (daily.get(event.day) || 0) + event.normalized);
    if (!customers.has(event.customerId)) customers.set(event.customerId, []);
    customers.get(event.customerId).push(event);
  }
  const typicalOrder = median(orders.map((event) => event.normalized));
  const typicalDay = median([...daily.values()]);
  const mad = median(orders.map((event) => Math.abs(event.normalized - typicalOrder)));
  // A candidate must be large both as a customer order and in daily demand terms.
  const threshold = Math.max(6 * typicalOrder, typicalOrder + 8 * mad, 3 * typicalDay);
  const excluded = [];
  const cleaned = new Map();
  let recurringBulkCount = 0;
  for (const event of orders) {
    const candidate = event.normalized > threshold && orders.length >= 8;
    let regular = false;
    if (candidate) {
      // Raw OR normalized volumes preserve both fixed contractual batches and
      // seasonal bulk orders. Stockout gaps must not erase a recurring customer.
      const comparable = customers.get(event.customerId)
        .filter((other) => (other.quantity >= event.quantity / 2 && other.quantity <= event.quantity * 2)
          || (other.normalized >= event.normalized / 2 && other.normalized <= event.normalized * 2))
        .sort((a, b) => a.day - b.day);
      if (comparable.length >= 3 && comparable.at(-1).day - comparable[0].day >= 14) {
        const gaps = comparable.slice(1).map((other, index) => {
          let gap = other.day - comparable[index].day;
          for (let day = comparable[index].day + 1; day <= other.day; day++) {
            if (available.get(day) === false) gap--;
          }
          return Math.max(1, gap);
        });
        const typicalGap = median(gaps);
        const typicalCount = gaps.filter(gap => gap >= typicalGap / 2 && gap <= typicalGap * 1.5).length;
        regular = typicalGap > 0 && typicalCount / gaps.length >= 0.75;
      }
    }
    if (candidate && !regular) {
      excluded.push({ date: event.date, customerId: event.customerId, quantity: round(event.quantity), threshold: round(threshold * factors[month(event.day)]) });
    } else {
      cleaned.set(event.day, (cleaned.get(event.day) || 0) + event.quantity);
      if (candidate && regular) recurringBulkCount++;
    }
  }
  return { cleaned, excluded, recurringBulkCount };
}

/** Robust log slope over weekly means; seasonality has already been removed. */
function estimateTrend(observations) {
  const weeks = new Map();
  for (const item of observations) {
    const week = Math.floor(item.day / 7);
    const bucket = weeks.get(week) || { day: 0, demand: 0, count: 0 };
    bucket.day += item.day;
    bucket.demand += item.normalized;
    bucket.count++;
    weeks.set(week, bucket);
  }
  const points = [...weeks.values()]
    .filter((bucket) => bucket.count >= 3 && bucket.demand > 0)
    .map((bucket) => ({ day: bucket.day / bucket.count, log: Math.log(bucket.demand / bucket.count) }))
    .sort((a, b) => a.day - b.day);
  if (points.length < 8 || points.at(-1).day - points[0].day < 56) {
    return { dailyRate: 0, insufficient: true, capped: false };
  }
  const slopes = [];
  for (let left = 0; left < points.length; left++) {
    for (let right = left + 1; right < points.length; right++) {
      const distance = points[right].day - points[left].day;
      if (distance >= 28) slopes.push((points[right].log - points[left].log) / distance);
    }
  }
  const raw = median(slopes);
  const dailyRate = Math.max(Math.log(0.2) / 365, Math.min(Math.log(3) / 365, raw));
  return { dailyRate, insufficient: false, capped: Math.abs(raw - dailyRate) > 1e-10 };
}

function recommendation(dataset, inventory, product, category, warehouse, supplier, options, indexes) {
  const asOf = dayNumber(dataset.asOf);
  const start = dayNumber(dataset.historyStart);
  const pair = key(product.id, inventory.warehouseId);
  const sales = indexes.sales.get(pair) || [];
  const available = indexes.availability.get(pair) || new Map();
  const arrivals = indexes.inbound.get(pair) || [];
  const { cleaned, excluded, recurringBulkCount } = cleanSales(sales, category, start, asOf, available);
  const warnings = [];
  const observations = [];
  let missingAvailability = 0;
  for (let day = start; day < asOf; day++) {
    if (available.get(day) === true) {
      observations.push({ day, normalized: (cleaned.get(day) || 0) / category.seasonality[month(day)] });
    } else if (!available.has(day)) missingAvailability++;
  }
  if (missingAvailability) warnings.push(`Нет статуса наличия за ${missingAvailability} дн.; эти дни исключены из обучения.`);
  const learned = estimateTrend(observations);
  const manual = options.growthMode === 'manual';
  const manualAnnual = finite(options.annualGrowthPct);
  if (manual && manualAnnual <= -100) throw new Error('Годовой прирост должен быть больше −100%.');
  const dailyRate = manual ? Math.log1p(manualAnnual / 100) / 365 : learned.dailyRate;
  if (!manual && learned.insufficient) warnings.push('Для устойчивого тренда нужно не менее 8 недель наблюдений и 56 дней; принят прирост 0%.');
  if (!manual && learned.capped) warnings.push('Автоматический годовой тренд ограничен диапазоном от −80% до +200%.');
  const recent = observations.filter((item) => item.day >= asOf - 180);
  const training = recent.length >= 14 ? recent : observations;
  // The same chosen trend is used for aligning history AND extrapolating the future.
  // Missing-stock days are absent here, so imputed lost demand is never added again.
  const base = training.length ? sum(training.map((item) => item.normalized * Math.exp(dailyRate * (asOf - item.day)))) / training.length : 0;
  if (training.length < 14) warnings.push('Менее 14 дней продаж при наличии: оценка спроса ненадёжна.');
  if (!observations.length) warnings.push('Нет дней подтверждённого наличия; спрос и заказ не могут быть достоверно оценены.');
  const demand = (day) => base * Math.exp(dailyRate * (day - asOf)) * category.seasonality[month(day)];
  let lostDemand = 0;
  let stockoutDays = 0;
  for (let day = start; day < asOf; day++) {
    if (available.get(day) === false) {
      stockoutDays++;
      lostDemand += Math.max(0, demand(day) - (cleaned.get(day) || 0));
    }
  }
  const leadTimeDays = Math.max(0, Math.floor(finite(product.leadTimeDays)));
  const reviewDays = Math.max(1, Math.floor(finite(category.reviewDays, 7)));
  const safetyDays = Math.max(0, Math.floor(finite(category.safetyDays)));
  const horizon = leadTimeDays + reviewDays;
  const horizonEnd = asOf + horizon;
  const forecast = Array.from({ length: horizon }, (_, offset) => demand(asOf + offset));
  const forecastDemand = sum(forecast);
  const safetyStock = sum(Array.from({ length: safetyDays }, (_, offset) => demand(horizonEnd + offset)));
  const onHand = positive(inventory.onHand);
  const arrivalDays = new Map();
  let inboundOnTime = 0;
  let inboundLate = 0;
  let overdueInbound = 0;
  for (const arrival of arrivals) {
    const day = dayNumber(arrival.eta);
    const quantity = positive(arrival.quantity);
    if (day < asOf) {
      overdueInbound += quantity;
      inboundLate += quantity;
    } else if (day < horizonEnd) {
      inboundOnTime += quantity;
      arrivalDays.set(day, (arrivalDays.get(day) || 0) + quantity);
    } else inboundLate += quantity;
  }
  if (overdueInbound) warnings.push(`Просрочено в пути ${n(overdueInbound)} ${product.unit || 'шт.'}; дата поступления неизвестна, в покрытие не включено.`);
  let balance = onHand;
  let naturalBalance = onHand;
  let required = 0;
  let preArrivalShortfall = 0;
  let stockoutDate = null;
  let bottleneckDate = null;
  let bottleneckDemand = 0;
  let bottleneckInbound = 0;
  let cumulativeDemand = 0;
  let cumulativeInbound = 0;
  for (let offset = 0; offset < horizon; offset++) {
    const day = asOf + offset;
    const received = arrivalDays.get(day) || 0;
    cumulativeInbound += received;
    cumulativeDemand += forecast[offset];
    naturalBalance += received;
    if (!stockoutDate && naturalBalance + 1e-9 < forecast[offset]) stockoutDate = dateString(day);
    naturalBalance = Math.max(0, naturalBalance - forecast[offset]);
    balance += received;
    if (offset < leadTimeDays) {
      preArrivalShortfall += Math.max(0, forecast[offset] - balance);
      balance = Math.max(0, balance - forecast[offset]);
    } else {
      balance -= forecast[offset];
      const needed = Math.max(0, safetyStock - balance);
      if (needed > required + 1e-9) {
        required = needed;
        bottleneckDate = dateString(day);
        bottleneckDemand = cumulativeDemand;
        bottleneckInbound = cumulativeInbound;
      }
    }
  }
  const packSize = Math.max(1, finite(product.packSize, 1));
  const suggestedQuantity = Math.ceil(Math.max(0, required - 1e-8) / packSize) * packSize;
  const simpleNet = Math.max(0, forecastDemand - preArrivalShortfall + safetyStock - onHand - inboundOnTime);
  const timingShortfall = Math.max(0, required - simpleNet);
  const urgency = preArrivalShortfall > 1e-8 ? 'critical' : stockoutDate ? 'soon' : 'normal';
  if (preArrivalShortfall > 1e-8) warnings.push(`До обычной поставки ${dateString(asOf + leadTimeDays)} возможен потерянный спрос ${n(preArrivalShortfall)} ${product.unit || 'шт.'}; требуется ускорение или перемещение.`);
  const formula = required > 0
    ? `Максимум потребности ${bottleneckDate}: спрос ${n(bottleneckDemand)} + буфер ${n(safetyStock)} − остаток ${n(onHand)} − поступления к этой дате ${n(bottleneckInbound)} − ранний неудовлетворённый спрос ${n(preArrivalShortfall)} = ${n(required)}.`
    : `Во все дни после новой поставки остатка и подтверждённого пути достаточно для спроса и буфера ${n(safetyStock)}; потребность 0.`;
  const explanation = `База ${n(base)} ${product.unit || 'шт.'}/день без сезонности; прирост ${n((Math.exp(dailyRate * 365) - 1) * 100)}%/год (${manual ? 'задан вручную вместо тренда' : 'оценён по истории'}). `
    + `Горизонт ${leadTimeDays} + ${reviewDays} = ${horizon} дн., прогноз ${n(forecastDemand)}, страховой запас на ${safetyDays} дн. ${n(safetyStock)}. `
    + `В пути в горизонте ${n(inboundOnTime)}, позднее/просрочено ${n(inboundLate)}. ${formula} `
    + `Заказ ${n(suggestedQuantity)} с округлением вверх до упаковки ${n(packSize)}. `
    + `Упущенный спрос в истории ${n(lostDemand)} за ${stockoutDays} дн. отсутствия; исключено ${excluded.length} разовых клиентских заказов на ${n(sum(excluded.map((event) => event.quantity)))}.`;
  return {
    id: pair, productId: product.id, productName: product.name,
    warehouseId: warehouse.id, warehouseName: warehouse.name,
    categoryId: category.id, categoryName: category.name,
    supplierId: supplier.id, supplierName: supplier.name,
    unit: product.unit || 'шт.', onHand, inboundOnTime: round(inboundOnTime), inboundLate: round(inboundLate),
    leadTimeDays, reviewDays, safetyDays, baseDailyDemand: round(base, 4),
    annualGrowthPct: round((Math.exp(dailyRate * 365) - 1) * 100), growthMode: manual ? 'manual' : 'auto',
    forecastDemand: round(forecastDemand), safetyStock: round(safetyStock),
    suggestedQuantity, requiredQuantity: round(required), packSize, urgency, stockoutDate,
    lostDemand: round(lostDemand), stockoutDays, outlierQuantity: round(sum(excluded.map((event) => event.quantity))),
    outlierCount: excluded.length, excludedOutliers: excluded, recurringBulkCount,
    preArrivalShortfall: round(preArrivalShortfall), timingShortfall: round(timingShortfall),
    forecastDemandBeforeArrival: round(sum(forecast.slice(0, leadTimeDays))),
    forecastDemandAfterArrival: round(sum(forecast.slice(leadTimeDays))),
    arrivalDate: dateString(asOf + leadTimeDays), horizonEnd: dateString(horizonEnd - 1),
    bottleneckDate, observedInStockDays: observations.length, trainingDays: training.length,
    explanation, warnings,
  };
}

/** Expects a validated schemaVersion: 1 dataset. Does not mutate dataset or options. */
export function calculateRecommendations(dataset, options = {}) {
  if (options.growthMode !== undefined && !['auto', 'manual'].includes(options.growthMode)) throw new Error('Неизвестный режим прироста.');
  if (options.growthMode === 'manual' && (typeof options.annualGrowthPct !== 'number' || !Number.isFinite(options.annualGrowthPct) || options.annualGrowthPct < -90 || options.annualGrowthPct > 200)) {
    throw new Error('Годовой прирост должен быть больше −100% и находиться в диапазоне от −90 до +200%.');
  }
  const products = new Map(dataset.products.map((item) => [item.id, item]));
  const categories = new Map(dataset.categories.map((item) => [item.id, item]));
  const warehouses = new Map(dataset.warehouses.map((item) => [item.id, item]));
  const suppliers = new Map(dataset.suppliers.map((item) => [item.id, item]));
  const indexes = { sales: new Map(), availability: new Map(), inbound: new Map() };
  for (const collection of ['sales', 'inbound']) {
    for (const item of dataset[collection]) {
      const pair = key(item.productId, item.warehouseId);
      if (!indexes[collection].has(pair)) indexes[collection].set(pair, []);
      indexes[collection].get(pair).push(item);
    }
  }
  for (const item of dataset.availability) {
    const pair = key(item.productId, item.warehouseId);
    if (!indexes.availability.has(pair)) indexes.availability.set(pair, new Map());
    indexes.availability.get(pair).set(dayNumber(item.date), item.inStock);
  }
  const rows = dataset.inventory.filter((item) => {
    const product = products.get(item.productId);
    return product && (!options.warehouseId || options.warehouseId === 'all' || options.warehouseId === item.warehouseId)
      && (!options.categoryId || options.categoryId === 'all' || options.categoryId === product.categoryId);
  }).map((inventory) => {
    const product = products.get(inventory.productId);
    return recommendation(dataset, inventory, product, categories.get(product.categoryId), warehouses.get(inventory.warehouseId), suppliers.get(product.supplierId), options, indexes);
  });
  const rank = { critical: 0, soon: 1, normal: 2 };
  rows.sort((a, b) => a.supplierName.localeCompare(b.supplierName, 'ru') || rank[a.urgency] - rank[b.urgency] || a.productName.localeCompare(b.productName, 'ru') || a.warehouseName.localeCompare(b.warehouseName, 'ru'));
  return {
    rows,
    summary: {
      rowCount: rows.length, supplierCount: new Set(rows.map((row) => row.supplierId)).size,
      recommendedCount: rows.filter((row) => row.suggestedQuantity > 0).length,
      criticalCount: rows.filter((row) => row.urgency === 'critical').length,
      soonCount: rows.filter((row) => row.urgency === 'soon').length,
      totalSuggestedQuantity: sum(rows.map((row) => row.suggestedQuantity)),
      totalLostDemand: round(sum(rows.map((row) => row.lostDemand))),
      totalOutlierQuantity: round(sum(rows.map((row) => row.outlierQuantity))),
      totalOutlierCount: sum(rows.map((row) => row.outlierCount)),
      totalPreArrivalShortfall: round(sum(rows.map((row) => row.preArrivalShortfall))),
    },
    warnings: [...new Set(rows.flatMap((row) => row.warnings))],
  };
}
