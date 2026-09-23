/** Monthly, local-only calculation for imported supplier data. No daily history is fabricated. */
const DAY = 86_400_000;
const day = value => Date.parse(`${value}T00:00:00Z`) / DAY;
const iso = value => new Date(value * DAY).toISOString().slice(0, 10);
const validNumber = value => typeof value === 'number' && Number.isFinite(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(day(value)) && iso(day(value)) === value;
const sum = values => values.reduce((total, value) => total + value, 0);
const round = (value, digits = 2) => value == null ? null : Math.round((value + Number.EPSILON) * 10 ** digits) / 10 ** digits;
const number = value => value == null ? 'неизвестно' : value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : 0;
};
const monthStart = month => day(`${month}-01`);
const nextMonth = month => {
  const [year, index] = month.split('-').map(Number);
  return Date.UTC(year, index, 1) / DAY;
};
const monthDays = month => nextMonth(month) - monthStart(month);
const sourceLabel = source => {
  if (!source) return 'источник не указан';
  if (typeof source === 'string') return source;
  return [source.file || source.filename, source.sheet, source.cell || source.range || (source.row ? `строка ${source.row}` : '')].filter(Boolean).join(' / ') || JSON.stringify(source);
};
const sourceUnique = sources => [...new Map(sources.filter(Boolean).map(source => [JSON.stringify(source), source])).values()];

function validateOptions(dataset, input) {
  if (dataset.schemaVersion !== 2 || !validDate(dataset.asOf)) throw new Error('Нужен импортированный набор версии 2 с корректной датой расчёта.');
  if (input.assumptionsConfirmed !== true) throw new Error('Подтвердите допущения для расчёта реальных данных.');
  for (const [name, min, max] of [['leadTimeDays', 0, 730], ['reviewDays', 1, 365], ['safetyDays', 0, 365]]) {
    if (!Number.isInteger(input[name]) || input[name] < min || input[name] > max) throw new Error(`Задайте ${name}: целое число от ${min} до ${max}.`);
  }
  const options = {
    warehouseId: 'global', categoryId: 'all', supplierId: 'all', growthMode: 'auto', lookbackMonths: 12,
    seasonalityMode: 'supplier', stockMode: 'latest', unknownStock: 'block', monthlyBlanks: 'unknown',
    salesSource: 'monthly', includePartialMonth: false, ...input,
  };
  for (const [key, allowed] of Object.entries({ growthMode: ['auto', 'manual'], seasonalityMode: ['supplier', 'none'], stockMode: ['latest', 'none'], unknownStock: ['block', 'zero-assumption'], monthlyBlanks: ['unknown', 'zero-assumption'], salesSource: ['monthly', 'detail'] })) {
    if (!allowed.includes(options[key])) throw new Error(`Неизвестная настройка ${key}.`);
  }
  if (options.warehouseId === 'all') options.warehouseId = 'global';
  if (!dataset.warehouses.some(item => item.id === options.warehouseId)) throw new Error('Склад не найден в импортированных данных.');
  if (options.growthMode === 'manual' && (!validNumber(options.annualGrowthPct) || options.annualGrowthPct < -90 || options.annualGrowthPct > 200)) throw new Error('Ручной годовой прирост должен быть числом от −90 до +200%.');
  if (!Number.isInteger(options.lookbackMonths) || options.lookbackMonths < 1 || options.lookbackMonths > 120) throw new Error('История расчёта должна составлять от 1 до 120 месяцев.');
  for (const [key, min] of [['fallbackPackSize', Number.MIN_VALUE], ['fallbackMoq', 0]]) {
    if (options[key] != null && (!validNumber(options[key]) || options[key] < min)) throw new Error(`Некорректное допущение ${key}.`);
  }
  if (options.fallbackPackSize != null && !Number.isInteger(options.fallbackPackSize)) throw new Error('fallbackPackSize должен быть положительным целым числом: текущий план использует целые единицы.');
  if (options.stockSnapshotDate && !validDate(options.stockSnapshotDate)) throw new Error('Некорректная дата снимка остатков.');
  if (options.stockSnapshotDate && day(options.stockSnapshotDate) > day(dataset.asOf)) throw new Error('Дата снимка остатков не может быть позже даты расчёта.');
  if (options.etaYear != null && (!Number.isInteger(options.etaYear) || options.etaYear < 2000 || options.etaYear > 2100)) throw new Error('Год ожидаемых поставок должен быть целым числом от 2000 до 2100.');
  if (options.warehouseId !== 'global' && options.salesSource !== 'detail') throw new Error('Для отдельного склада выберите подробные продажи: ежемесячные продажи не распределены по складам.');
  if (options.salesSource === 'detail' && options.confirmDetailScope !== true) throw new Error('Подтвердите разрез подробного отчёта: он может отличаться от разреза ежемесячных продаж.');
  return options;
}

function supplierSeasonality(supplier, asOf, options) {
  const warnings = [];
  if (options.seasonalityMode === 'none') return { factors: Array(12).fill(1), years: [], sources: [], warnings: ['Сезонность отключена пользователем: коэффициенты равны 1.'] };
  const complete = (supplier.seasonalityYears || []).filter(item => Number.isInteger(item.year)
    && day(`${item.year + 1}-01-01`) <= asOf && item.values?.length === 12 && item.values.every(value => validNumber(value) && value > 0));
  const skipped = (supplier.seasonalityYears || []).length - complete.length;
  if (skipped) warnings.push(`Сезонность: исключено неполных, незавершённых или некорректных лет: ${skipped}.`);
  if (!complete.length) return { factors: Array(12).fill(1), years: [], sources: [], warnings: [...warnings, 'Нет полного завершённого года сезонности; коэффициенты приняты равными 1.'] };
  const years = complete.map(item => {
    const durations = item.values.map((_, index) => monthDays(`${item.year}-${String(index + 1).padStart(2, '0')}`));
    const average = sum(item.values) / sum(durations);
    return item.values.map((value, index) => value / durations[index] / average);
  });
  const factors = Array.from({ length: 12 }, (_, index) => sum(years.map(values => values[index])) / years.length);
  warnings.push('Сезонность получена из общего показателя поставщика; это допущение для каждого товара, не индивидуальная сезонность SKU. Годовой масштаб снят нормировкой.');
  return { factors, years: complete.map(item => item.year), sources: sourceUnique(complete.map(item => item.source)), warnings };
}

function monthlyObservations(product, supplier, asOf, options, seasonality, warnings) {
  const date = new Date(asOf * DAY);
  const cutoff = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - options.lookbackMonths, 1) / DAY;
  let records;
  if (options.salesSource === 'detail') {
    const groups = new Map();
    for (const row of product.detailMonthly || []) {
      if (options.warehouseId !== 'global' && row.warehouseId !== options.warehouseId) continue;
      const record = groups.get(row.month) || { month: row.month, quantity: 0, negative: 0, returns: 0, corrections: 0, sources: [] };
      record.quantity += validNumber(row.positive) ? Math.max(0, row.positive) : 0;
      record.negative += validNumber(row.negative) ? row.negative : 0;
      record.returns += validNumber(row.returns) ? row.returns : 0;
      record.corrections += validNumber(row.corrections) ? row.corrections : 0;
      if (row.source) record.sources.push(row.source);
      groups.set(row.month, record);
    }
    // Missing months stay unknown unless the manager explicitly chooses zero.
    // Generate only compact monthly records within the declared report period.
    if (validDate(supplier.detailPeriod?.start) && validDate(supplier.detailPeriod?.end)) {
      const reportStart = Math.max(cutoff, monthStart(supplier.detailPeriod.start.slice(0, 7)));
      const reportEnd = Math.min(asOf, day(supplier.detailPeriod.end) + 1);
      for (let current = reportStart; current < reportEnd; current = nextMonth(iso(current).slice(0, 7))) {
        const month = iso(current).slice(0, 7);
        if (!groups.has(month)) groups.set(month, { month, quantity: null, negative: null, returns: null, corrections: null, sources: [], absentDetailMonth: true });
      }
    } else warnings.push('Период подробного отчёта не установлен: отсутствующие месяцы нельзя интерпретировать как нулевые продажи.');
    records = [...groups.values()];
    warnings.push('Используются только положительные подробные продажи выбранного разреза; возвраты и отрицательные корректировки показаны отдельно. Ежемесячные продажи не прибавляются.');
  } else {
    records = (product.monthlySales || []).map(row => ({ ...row, sources: row.source ? [row.source] : [], negative: validNumber(row.quantity) ? Math.min(0, row.quantity) : null, returns: null, corrections: null }));
    warnings.push('Используются только ежемесячные продажи. Положительный итог может включать возвраты: разложить его на отгрузки и возвраты по этой таблице нельзя. Подробные продажи служат отдельной сверкой.');
  }
  let missingMonths = 0;
  let partialMonths = 0;
  const observations = [];
  for (const record of records) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(record.month)) continue;
    const start = monthStart(record.month);
    const end = nextMonth(record.month);
    if (start >= asOf || start < cutoff) continue;
    let coveredStart = start;
    let coveredEnd = Math.min(end, asOf);
    if (options.salesSource === 'detail') {
      if (validDate(supplier.detailPeriod?.start)) coveredStart = Math.max(coveredStart, day(supplier.detailPeriod.start));
      if (validDate(supplier.detailPeriod?.end)) coveredEnd = Math.min(coveredEnd, day(supplier.detailPeriod.end) + 1);
    }
    if (coveredEnd <= coveredStart) continue;
    const incomplete = coveredStart !== start || coveredEnd !== end;
    if (incomplete && !options.includePartialMonth) { partialMonths++; continue; }
    let quantity = record.quantity;
    let assumedZero = false;
    if (!validNumber(quantity)) {
      missingMonths++;
      if (options.monthlyBlanks !== 'zero-assumption') continue;
      quantity = 0;
      assumedZero = true;
    }
    if (incomplete) partialMonths++;
    const days = coveredEnd - coveredStart;
    const factor = seasonality.factors[Number(record.month.slice(5)) - 1];
    observations.push({ ...record, quantity, demandQuantity: Math.max(0, quantity), days, day: coveredStart + (days - 1) / 2,
      normalized: Math.max(0, quantity) / days / factor, factor, incomplete, assumedZero });
  }
  observations.sort((a, b) => a.day - b.day);
  if (missingMonths) warnings.push(`Пустых/неизвестных ${options.salesSource === 'detail' ? 'месяцев подробного отчёта' : 'ежемесячных значений'}: ${missingMonths}; ${options.monthlyBlanks === 'zero-assumption' ? 'по явному допущению приняты за нулевые продажи' : 'исключены из оценки, не заменены нулём; оценка по активным месяцам может завышать средний спрос'}.`);
  if (partialMonths) warnings.push(`Неполных месяцев: ${partialMonths}; ${options.includePartialMonth ? 'включены по явному допущению с делением на известную часть месяца' : 'исключены из обучения'}.`);
  if (observations.some(record => record.quantity < 0)) warnings.push('Отрицательные ежемесячные итоги сохранены отдельно; отрицательный спрос не прогнозируется.');
  return observations;
}

function growth(observations, options, warnings) {
  if (options.growthMode === 'manual') return Math.log1p(options.annualGrowthPct / 100) / 365;
  const points = observations.filter(record => record.normalized > 0 && !record.incomplete);
  if (points.length < 6 || points.at(-1).day - points[0].day < 150) {
    warnings.push('Для устойчивого тренда недостаточно шести положительных полных месяцев за 150 дней; принят прирост 0%.');
    return 0;
  }
  const slopes = [];
  for (let left = 0; left < points.length; left++) {
    for (let right = left + 1; right < points.length; right++) {
      const distance = points[right].day - points[left].day;
      if (distance >= 28) slopes.push(Math.log(points[right].normalized / points[left].normalized) / distance);
    }
  }
  const raw = median(slopes);
  const rate = Math.max(Math.log(0.2) / 365, Math.min(Math.log(3) / 365, raw));
  if (Math.abs(raw - rate) > 1e-10) warnings.push('Автоматический годовой прирост ограничен диапазоном от −80% до +200%.');
  if (points.length !== observations.length) warnings.push('Нулевые и неполные месяцы не участвуют в логарифмическом тренде; при прерывистых продажах оценка роста ненадёжна.');
  return rate;
}

function stockFor(product, asOf, options, warnings) {
  let selected = null;
  let reason = '';
  if (options.warehouseId !== 'global') reason = 'Общие остатки нельзя распределить по выбранному складу.';
  else if (options.stockMode === 'none') reason = 'Учёт остатков отключён пользователем.';
  else {
    const records = (product.stocks || []).map(record => {
      const effectiveDate = validDate(record.date) ? record.date : validDate(options.stockSnapshotDate) ? options.stockSnapshotDate : null;
      return { ...record, effectiveDate, assumedDate: !validDate(record.date) && !!effectiveDate };
    });
    const eligible = records.filter(record => (!record.effectiveDate || day(record.effectiveDate) <= asOf)
      && (!record.month || monthStart(record.month) <= asOf));
    const free = eligible.filter(record => record.basis === 'free');
    const candidates = free.length ? free : eligible;
    candidates.sort((a, b) => String(b.month || b.date || b.effectiveDate || '').localeCompare(String(a.month || a.date || a.effectiveDate || '')));
    selected = candidates[0] || null;
    if (!selected) reason = 'Нет допустимого снимка остатков.';
    else if (!validNumber(selected.quantity)) reason = 'Последний снимок содержит неизвестный остаток; более раннее значение не подставлено.';
    else if (selected.quantity < 0) reason = 'Отрицательный остаток требует проверки исходного отчёта.';
    else if (!selected.effectiveDate) reason = 'Дата снимка остатков неизвестна; задайте явную дату снимка.';
    else if (selected.basis === 'unknown-monthly' && selected.assumedDate && selected.month && selected.effectiveDate.slice(0, 7) !== selected.month) reason = `Заданная дата снимка ${selected.effectiveDate} не относится к месяцу исходного остатка ${selected.month}.`;
    else {
      const age = asOf - day(selected.effectiveDate);
      if (selected.assumedDate) warnings.push(`Дата остатка ${selected.effectiveDate} задана пользователем, а не установлена из исходного файла.`);
      if (age > 1 && options.allowStaleStock !== true) reason = `Остаток устарел на ${age} дн.; требуется разрешить использование старого снимка.`;
      else {
        if (age > 1) warnings.push(`Используется старый снимок ${selected.effectiveDate} (${age} дн. до расчёта); движение после снимка не восстанавливается.`);
        if (selected.basis === 'free') warnings.push('Использован свободный остаток: резерв повторно не вычитается.');
        else warnings.push('Использован месячный снимок остатка; доступность по дням и свободная часть не установлены. Резерв не вычитается без подтверждённого основания.');
        return { onHand: selected.quantity, record: selected, status: 'known', date: selected.effectiveDate, ageDays: age };
      }
    }
  }
  warnings.push(reason);
  if (options.unknownStock === 'zero-assumption') {
    warnings.push('Неизвестный остаток принят за 0 по явному допущению пользователя; это не подтверждённый нулевой остаток.');
    return { onHand: 0, record: selected, status: 'assumed-zero', date: selected?.effectiveDate || null, ageDays: null };
  }
  return { onHand: null, record: selected, status: 'unknown', date: selected?.effectiveDate || null, ageDays: null, blockedReason: reason };
}

function arrivalsFor(product, asOf, horizonEnd, options, warnings) {
  const result = { byDay: new Map(), onTime: 0, late: 0, unknown: 0, overdue: 0, records: [] };
  for (const record of product.inbound || []) {
    const quantity = validNumber(record.quantity) ? record.quantity : 0;
    if (quantity <= 0) continue;
    let eta = validDate(record.eta) ? record.eta : null;
    let assumedYear = false;
    if (!eta && record.etaType === 'year-missing' && options.etaYear && /^\d{2}-\d{2}$/.test(record.etaMonthDay || '')) {
      const candidate = `${options.etaYear}-${record.etaMonthDay}`;
      if (validDate(candidate)) { eta = candidate; assumedYear = true; }
    }
    let use = 'unknown-date';
    if (options.warehouseId !== 'global') { result.unknown += quantity; use = 'global-scope'; }
    else if (!eta) result.unknown += quantity;
    else if (day(eta) < asOf) { result.overdue += quantity; result.late += quantity; use = 'overdue'; }
    else if (day(eta) >= horizonEnd) { result.late += quantity; use = 'after-horizon'; }
    else {
      result.onTime += quantity;
      result.byDay.set(day(eta), (result.byDay.get(day(eta)) || 0) + quantity);
      use = 'in-horizon';
    }
    result.records.push({ ...record, effectiveEta: eta, assumedYear, use });
  }
  if (result.unknown) warnings.push(`Путь ${number(result.unknown)} не включён: ${options.warehouseId !== 'global' ? 'общие партии нельзя распределить по отдельному складу' : 'нет подтверждённой даты/года поставки'}.`);
  if (result.overdue) warnings.push(`Просрочено в пути ${number(result.overdue)}; поступление не подтверждено и в покрытие не включено.`);
  if (result.records.some(record => record.assumedYear)) warnings.push(`Год дат поставок без года (${options.etaYear}) принят по явному допущению пользователя.`);
  if (result.records.some(record => record.etaType === 'deadline')) warnings.push('Для сроков «до даты» поступление консервативно принято в последний указанный день.');
  return result;
}

function calculateRow(dataset, product, supplier, category, warehouse, options, seasonality) {
  const asOf = day(dataset.asOf);
  const warnings = [...(product.warnings || []), ...(supplier.warnings || []), ...seasonality.warnings];
  if (!product.unit) warnings.push('Единица измерения не указана в источниках: «ед.» обозначает абстрактные единицы исходного отчёта, не штуки.');
  const reasons = [];
  if (product.unitConversionRequired) {
    const message = 'Закупочные и складские единицы требуют подтверждённого коэффициента перевода. Текущий MVP не поддерживает пересчёт: исключите строку из плана и рассчитайте отдельно.';
    reasons.push(message);
    warnings.push(message);
  }
  const observations = monthlyObservations(product, supplier, asOf, options, seasonality, warnings);
  if (!observations.length) reasons.push('Нет пригодных месяцев продаж в выбранном периоде и разрезе.');
  const dailyRate = growth(observations, options, warnings);
  const trainingDays = sum(observations.map(record => record.days));
  const base = trainingDays ? sum(observations.map(record => record.normalized * record.days * Math.exp(dailyRate * (asOf - record.day)))) / trainingDays : null;
  const stock = stockFor(product, asOf, options, warnings);
  if (stock.blockedReason) reasons.push(stock.blockedReason);
  const packKnown = Number.isInteger(product.packSize) && product.packSize > 0;
  const moqKnown = validNumber(product.moq) && product.moq >= 0;
  const packSize = packKnown ? product.packSize : options.fallbackPackSize ?? null;
  const moq = moqKnown ? product.moq : options.fallbackMoq ?? null;
  if (!packKnown && packSize != null) warnings.push(`Кратность ${number(packSize)} принята по явному допущению пользователя; в источнике отсутствует.`);
  if (validNumber(product.packSize) && !packKnown) warnings.push('Исходная кратность не является положительным целым числом; требуется проверка единиц и кратности.');
  if (!moqKnown && moq != null) warnings.push(`Минимальная партия ${number(moq)} принята по явному допущению пользователя; в источнике отсутствует.`);
  if (packSize == null) reasons.push('Неизвестна кратность упаковки; задайте явное допущение.');
  if (moq == null) reasons.push('Неизвестна минимальная партия (MOQ); задайте явное допущение.');
  const { leadTimeDays, reviewDays, safetyDays } = options;
  const horizon = leadTimeDays + reviewDays;
  const horizonEnd = asOf + horizon;
  const demand = targetDay => (base || 0) * Math.exp(dailyRate * (targetDay - asOf)) * seasonality.factors[new Date(targetDay * DAY).getUTCMonth()];
  // Only the short future horizon is expanded by day, never imported history.
  const forecast = Array.from({ length: horizon }, (_, index) => demand(asOf + index));
  const forecastDemand = sum(forecast);
  const safetyStock = sum(Array.from({ length: safetyDays }, (_, index) => demand(horizonEnd + index)));
  const inbound = arrivalsFor(product, asOf, horizonEnd, options, warnings);
  let balance = stock.onHand || 0;
  let naturalBalance = balance;
  let required = 0;
  let preArrivalShortfall = 0;
  let stockoutDate = null;
  let bottleneckDate = null;
  let cumulativeDemand = 0;
  let cumulativeInbound = 0;
  let bottleneckDemand = 0;
  let bottleneckInbound = 0;
  for (let offset = 0; offset < horizon; offset++) {
    const targetDay = asOf + offset;
    const received = inbound.byDay.get(targetDay) || 0;
    cumulativeInbound += received;
    cumulativeDemand += forecast[offset];
    naturalBalance += received;
    if (!stockoutDate && naturalBalance + 1e-9 < forecast[offset]) stockoutDate = iso(targetDay);
    naturalBalance = Math.max(0, naturalBalance - forecast[offset]);
    balance += received;
    if (offset < leadTimeDays) {
      preArrivalShortfall += Math.max(0, forecast[offset] - balance);
      balance = Math.max(0, balance - forecast[offset]);
    } else {
      balance -= forecast[offset];
      const needed = Math.max(0, safetyStock - balance);
      if (needed > required + 1e-9) {
        required = needed; bottleneckDate = iso(targetDay);
        bottleneckDemand = cumulativeDemand; bottleneckInbound = cumulativeInbound;
      }
    }
  }
  const blockedReason = reasons.length ? reasons.join(' ') : null;
  const suggestedQuantity = blockedReason ? null : required > 1e-8 ? round(Math.ceil((Math.max(required, moq) - 1e-8) / packSize) * packSize, 8) : 0;
  const simpleNet = Math.max(0, forecastDemand - preArrivalShortfall + safetyStock - (stock.onHand || 0) - inbound.onTime);
  const stockAndSalesKnown = stock.onHand != null && base != null;
  const urgency = blockedReason ? 'blocked' : preArrivalShortfall > 1e-8 ? 'critical' : stockoutDate ? 'soon' : 'normal';
  if (stockAndSalesKnown && preArrivalShortfall > 1e-8) warnings.push(`До нового заказа ${iso(asOf + leadTimeDays)} возможен неудовлетворённый спрос ${number(preArrivalShortfall)}; требуется ускорение/перемещение. В заказ этот прошлый к прибытию спрос повторно не добавляется.`);
  warnings.push('Месячные снимки не определяют точные дни отсутствия: упущенный спрос за историю не оценён.');
  warnings.push('Нет подтверждённого ID клиента: номер документа не считается клиентом. Разовые клиентские заказы автоматически не исключаются, регулярные крупные покупки сохранены.');
  warnings.push('Возвраты показаны только по явно распознанным типам документов. Ноль распознанных возвратов не подтверждает их отсутствие; отрицательные движения могут включать возвраты и корректировки.');
  const monthlyNegative = sum(observations.map(record => Math.min(0, record.negative || 0)));
  const detailRows = (product.detailMonthly || []).filter(record => options.warehouseId === 'global' || record.warehouseId === options.warehouseId);
  const detailNegative = sum(detailRows.map(record => validNumber(record.negative) ? record.negative : 0));
  const returns = sum(detailRows.map(record => validNumber(record.returns) ? record.returns : 0));
  const corrections = sum(detailRows.map(record => validNumber(record.corrections) ? record.corrections : 0));
  const largestLine = detailRows.filter(record => validNumber(record.maxLineQuantity)).reduce((largest, record) => !largest || record.maxLineQuantity > largest.maxLineQuantity ? record : largest, null);
  const salesSources = sourceUnique(observations.flatMap(record => record.sources));
  const sourceFacts = {
    asOf: dataset.asOf, salesSource: options.salesSource, salesPeriod: observations.length ? { start: observations[0].month, end: observations.at(-1).month } : null,
    salesMonths: observations.map(({ month, quantity, demandQuantity, negative, days, factor, incomplete, assumedZero, sources }) => ({ month, quantity, demandQuantity, negative, days, factor: round(factor, 6), incomplete, assumedZero, sources })),
    stock: stock.record, stockStatus: stock.status, stockDate: stock.date, inbound: inbound.records,
    seasonality: { years: seasonality.years, factors: seasonality.factors.map(value => round(value, 6)), sources: seasonality.sources },
    pack: { value: packSize, assumed: !packKnown, source: packKnown ? product.packSource : null },
    moq: { value: moq, assumed: !moqKnown, source: moqKnown ? product.moqSource : null },
    detailAdjustments: { negative: detailNegative, returns, corrections, period: supplier.detailPeriod || null, sources: sourceUnique(detailRows.map(record => record.source)), maxLineQuantity: largestLine?.maxLineQuantity ?? null, maxLineSource: largestLine?.maxLineSource ?? null },
    unitConversion: { required: product.unitConversionRequired === true, supported: false, source: product.unitConversionSource || null },
    assumptions: { leadTimeDays, reviewDays, safetyDays, unknownStock: options.unknownStock, allowStaleStock: options.allowStaleStock === true, stockSnapshotDate: options.stockSnapshotDate || null, etaYear: options.etaYear || null, includePartialMonth: options.includePartialMonth, monthlyBlanks: options.monthlyBlanks },
  };
  const formula = !stockAndSalesKnown ? 'Потребность не определена без известных продаж и остатка.' : required > 1e-8
    ? `Максимум потребности ${bottleneckDate}: спрос ${number(bottleneckDemand)} + буфер ${number(safetyStock)} − остаток ${number(stock.onHand)} − поступления к этой дате ${number(bottleneckInbound)} − ранний неудовлетворённый спрос ${number(preArrivalShortfall)} = ${number(required)}.`
    : `В каждый день после нового заказа остаток и подтверждённый путь покрывают спрос и буфер ${number(safetyStock)}: потребность 0.`;
  const explanation = `Код 1С ${product.code || 'не указан'}, артикул ${product.article || 'не указан'}. `
    + `Продажи: ${options.salesSource === 'monthly' ? 'ежемесячные' : 'подробные положительные'}, ${observations.length} мес., ${observations.length ? `${observations[0].month}…${observations.at(-1).month}` : 'нет периода'}, объём ${number(sum(observations.map(record => record.quantity)))}. `
    + `База ${number(base)} ${product.unit || 'ед. (единица не указана)'}/день без сезонности; рост ${number((Math.exp(dailyRate * 365) - 1) * 100)}%/год (${options.growthMode === 'manual' ? 'вручную вместо автоматического' : 'устойчивый тренд очищенного ряда'}), применяется один раз для выравнивания истории и прогноза. `
    + `Остаток ${number(stock.onHand)}, дата ${stock.date || 'неизвестна'}, статус ${stock.status === 'known' ? 'из источника' : stock.status === 'assumed-zero' ? 'явное допущение 0' : 'неизвестен'}. `
    + `Срок нового заказа ${leadTimeDays} дн. задан пользователем; горизонт ${leadTimeDays} + ${reviewDays} = ${horizon} дн., спрос ${number(base == null ? null : forecastDemand)}, буфер ${safetyDays} дн. = ${number(base == null ? null : safetyStock)}. `
    + `Путь в горизонте ${number(inbound.onTime)}, позже/просрочено ${number(inbound.late)}, без даты/разреза ${number(inbound.unknown)}. ${formula} `
    + `MOQ ${number(moq)}, кратность ${number(packSize)}; ${blockedReason ? `расчёт заблокирован: ${blockedReason}` : `заказ ${number(suggestedQuantity)} = ${required > 1e-8 ? 'округление вверх max(потребность, MOQ) до кратности' : '0 при отсутствии потребности'}`}. `
    + `Источник продаж: ${salesSources.map(sourceLabel).join('; ') || 'не указан'}. Остаток: ${sourceLabel(stock.record?.source)}. `
    + `Отрицательные месячные итоги ${number(monthlyNegative)}; в подробном отчёте отдельно отрицательные движения ${number(detailNegative)}, явно распознанные возвраты ${number(returns)}, корректировки ${number(corrections)}. Ноль распознанных возвратов не подтверждает их отсутствие. Исторический упущенный спрос и исключение заказов по клиентам не определены.`;
  return {
    id: JSON.stringify([product.id, options.warehouseId]), productId: product.id, productName: product.name, code: product.code, article: product.article,
    warehouseId: warehouse.id, warehouseName: warehouse.name, categoryId: category.id, categoryName: category.name,
    supplierId: supplier.id, supplierName: supplier.name, unit: product.unit || 'ед.', unitConversionRequired: product.unitConversionRequired === true,
    onHand: stock.onHand, stockStatus: stock.status, stockDate: stock.date, stockAgeDays: stock.ageDays,
    inboundOnTime: round(inbound.onTime), inboundLate: round(inbound.late), inboundUnknown: round(inbound.unknown), overdueInbound: round(inbound.overdue),
    leadTimeDays, reviewDays, safetyDays, baseDailyDemand: round(base, 4), annualGrowthPct: round((Math.exp(dailyRate * 365) - 1) * 100), growthMode: options.growthMode,
    forecastDemand: base == null ? null : round(forecastDemand), safetyStock: base == null ? null : round(safetyStock),
    suggestedQuantity, quantity: suggestedQuantity, requiredQuantity: stockAndSalesKnown ? round(required) : null, packSize, moq, urgency, blockedReason,
    stockoutDate: stockAndSalesKnown ? stockoutDate : null, lostDemand: null, stockoutDays: null, outlierQuantity: 0, outlierCount: 0, excludedOutliers: [], recurringBulkCount: null,
    preArrivalShortfall: stockAndSalesKnown ? round(preArrivalShortfall) : null, timingShortfall: stockAndSalesKnown ? round(Math.max(0, required - simpleNet)) : null,
    forecastDemandBeforeArrival: base == null ? null : round(sum(forecast.slice(0, leadTimeDays))), forecastDemandAfterArrival: base == null ? null : round(sum(forecast.slice(leadTimeDays))),
    arrivalDate: iso(asOf + leadTimeDays), horizonEnd: iso(horizonEnd - 1), bottleneckDate: stockAndSalesKnown ? bottleneckDate : null,
    observedInStockDays: null, trainingDays, trainingMonths: observations.length, monthlyNegative: round(monthlyNegative), detailNegative: round(detailNegative), returns: round(returns), corrections: round(corrections),
    explanation, warnings: [...new Set(warnings)], sourceFacts,
    sources: sourceUnique([...salesSources, stock.record?.source, ...inbound.records.map(record => record.source), ...seasonality.sources, product.packSource, product.moqSource, product.unitConversionSource, largestLine?.maxLineSource]),
  };
}

/** Calculate every selected product, retaining blocked rows and explicit unknown values. */
export function calculateRealRecommendations(dataset, input = {}) {
  const options = validateOptions(dataset, input);
  const suppliers = new Map(dataset.suppliers.map(item => [item.id, item]));
  const categories = new Map(dataset.categories.map(item => [item.id, item]));
  const warehouse = dataset.warehouses.find(item => item.id === options.warehouseId);
  const seasonal = new Map(dataset.suppliers.map(supplier => [supplier.id, supplierSeasonality(supplier, day(dataset.asOf), options)]));
  const rows = dataset.products.filter(product => (options.supplierId === 'all' || product.supplierId === options.supplierId)
    && (options.categoryId === 'all' || product.categoryId === options.categoryId)).map(product => {
    const supplier = suppliers.get(product.supplierId);
    if (!supplier) throw new Error(`Неизвестный поставщик товара ${product.id}.`);
    return calculateRow(dataset, product, supplier, categories.get(product.categoryId) || { id: product.categoryId || 'unknown', name: 'Категория не указана' }, warehouse, options, seasonal.get(supplier.id));
  });
  const rank = { critical: 0, soon: 1, normal: 2, blocked: 3 };
  rows.sort((a, b) => a.supplierName.localeCompare(b.supplierName, 'ru') || rank[a.urgency] - rank[b.urgency] || a.productName.localeCompare(b.productName, 'ru') || a.productId.localeCompare(b.productId));
  return {
    rows,
    summary: {
      rowCount: rows.length, supplierCount: new Set(rows.map(row => row.supplierId)).size,
      recommendedCount: rows.filter(row => row.suggestedQuantity > 0).length, blockedCount: rows.filter(row => row.blockedReason).length,
      criticalCount: rows.filter(row => row.urgency === 'critical').length, soonCount: rows.filter(row => row.urgency === 'soon').length,
      totalSuggestedQuantity: round(sum(rows.map(row => row.suggestedQuantity || 0))), totalLostDemand: null,
      totalOutlierQuantity: 0, totalOutlierCount: 0, totalPreArrivalShortfall: round(sum(rows.map(row => row.preArrivalShortfall || 0))),
    },
    warnings: [...new Set(rows.flatMap(row => row.warnings))],
  };
}
