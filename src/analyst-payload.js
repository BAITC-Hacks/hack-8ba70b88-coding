const clip = (value, length = 240) => value == null ? null : String(value).slice(0, length);

function sourceRef(value) {
  if (!value) return null;
  if (typeof value === 'string') return clip(value, 240);
  return clip([value.file || value.filename, value.sheet, value.cell || value.range || (value.row ? `строка ${value.row}` : '')].filter(Boolean).join(' / '), 240);
}

function itemFacts(row) {
  return {
    code1c: clip(row.productCode || row.code, 100), article: clip(row.article, 100), name: clip(row.productName, 180),
    supplier: clip(row.supplierName, 100), warehouse: clip(row.warehouseName, 100), category: clip(row.categoryName, 100),
    urgency: clip(row.urgency, 24), suggestedQuantity: Number.isFinite(row.suggestedQuantity) ? row.suggestedQuantity : null,
    currentQuantity: Number.isFinite(row.quantity) ? row.quantity : null, excluded: Boolean(row.excluded), unit: clip(row.unit, 24),
    onHand: Number.isFinite(row.onHand) ? row.onHand : null, stockStatus: clip(row.stockStatus, 40), stockDate: clip(row.stockDate, 24),
    inboundOnTime: Number.isFinite(row.inboundOnTime) ? row.inboundOnTime : null,
    inboundLate: Number.isFinite(row.inboundLate) ? row.inboundLate : null,
    leadTimeDays: Number.isFinite(row.leadTimeDays) ? row.leadTimeDays : null,
    forecastDemand: Number.isFinite(row.forecastDemand) ? row.forecastDemand : null,
    annualGrowthPct: Number.isFinite(row.annualGrowthPct) ? row.annualGrowthPct : null,
    moq: Number.isFinite(row.moq) ? row.moq : null, packSize: Number.isFinite(row.packSize) ? row.packSize : null,
    blockedReason: clip(row.blockedReason, 400), explanation: clip(row.explanation, 900),
    sources: [...new Set((row.sources || []).map(sourceRef).filter(Boolean))].slice(0, 5),
  };
}

/** Compact, allow-listed facts only. No workbook rows or full dataset are included. */
export function buildAnalystPayload({ draft, selectedProductId = '', question = '' }) {
  if (!draft || !Array.isArray(draft.rows) || !draft.rows.length) throw new Error('Сначала выполните расчёт плана.');
  const rows = draft.rows;
  const suppliers = new Map();
  for (const row of rows) {
    const name = clip(row.supplierName || 'Поставщик не указан', 100);
    const current = suppliers.get(name) || { supplier: name, positions: 0, orderPositions: 0, urgentPositions: 0, unresolvedPositions: 0, quantityTotal: 0 };
    current.positions++;
    if (!row.excluded && Number.isFinite(row.quantity) && row.quantity > 0) { current.orderPositions++; current.quantityTotal += row.quantity; }
    if (row.urgency === 'critical' || row.urgency === 'soon') current.urgentPositions++;
    if (!row.excluded && (row.quantity == null || (row.blockedReason && !row.manualDecision))) current.unresolvedPositions++;
    suppliers.set(name, current);
  }
  const rank = { critical: 0, soon: 1, normal: 2, blocked: 3 };
  const priorityItems = rows.filter(row => !row.excluded && (row.urgency === 'critical' || row.urgency === 'soon' || row.blockedReason))
    .sort((a, b) => (rank[a.urgency] ?? 4) - (rank[b.urgency] ?? 4) || (Number(b.preArrivalShortfall) || 0) - (Number(a.preArrivalShortfall) || 0))
    .slice(0, 5).map(itemFacts);
  const selected = selectedProductId ? rows.find(row => String(row.id) === String(selectedProductId)) : null;
  const questionText = String(question || '').trim().slice(0, 1200);
  const payload = {
    question: questionText || 'Кратко проанализируй текущий план закупок и назови приоритеты, риски и недостающие уточнения.',
    plan: {
      asOf: clip(draft.asOf, 24), datasetType: draft.isDemo ? 'synthetic_demo' : 'real_business_data',
      totalPositions: rows.length,
      orderPositions: rows.filter(row => !row.excluded && Number.isFinite(row.quantity) && row.quantity > 0).length,
      unresolvedPositions: rows.filter(row => !row.excluded && (row.quantity == null || (row.blockedReason && !row.manualDecision))).length,
      excludedPositions: rows.filter(row => row.excluded).length,
      manuallyChangedPositions: rows.filter(row => row.manualDecision && !row.excluded).length,
      urgentPositions: rows.filter(row => !row.excluded && (row.urgency === 'critical' || row.urgency === 'soon')).length,
      quantityTotal: rows.reduce((total, row) => total + (!row.excluded && Number.isFinite(row.quantity) ? row.quantity : 0), 0),
      suppliers: [...suppliers.values()].slice(0, 8),
      priorityItems,
      selectedItem: selected ? itemFacts(selected) : null,
    },
  };
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 24_000) throw new Error('Подготовленные сведения превышают безопасный размер 24 КБ. Сократите вопрос или выберите меньше дополнительных сведений.');
  return payload;
}

export function validateAnalystPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['question', 'plan'].includes(key))) throw new Error('Некорректный формат запроса аналитика.');
  if (typeof value.question !== 'string' || !value.question.trim() || value.question.length > 1200) throw new Error('Вопрос должен содержать не более 1 200 символов.');
  const plan = value.plan;
  const planKeys = ['asOf', 'datasetType', 'totalPositions', 'orderPositions', 'unresolvedPositions', 'excludedPositions', 'manuallyChangedPositions', 'urgentPositions', 'quantityTotal', 'suppliers', 'priorityItems', 'selectedItem'];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || Object.keys(plan).some(key => !planKeys.includes(key))) throw new Error('Сводка плана содержит неподдерживаемые поля.');
  const requiredCounts = ['totalPositions', 'orderPositions', 'unresolvedPositions', 'excludedPositions', 'manuallyChangedPositions', 'urgentPositions'];
  if (!requiredCounts.every(key => Number.isSafeInteger(plan[key]) && plan[key] >= 0) || !Number.isFinite(plan.quantityTotal) || plan.quantityTotal < 0) throw new Error('Сводка плана отсутствует или содержит неверные значения.');
  if (!['synthetic_demo', 'real_business_data'].includes(plan.datasetType) || !Array.isArray(plan.suppliers) || plan.suppliers.length > 8 || !Array.isArray(plan.priorityItems) || plan.priorityItems.length > 5) throw new Error('Состав передаваемых данных не поддерживается.');
  const count = (value, key) => {
    const allowed = ['supplier', 'positions', 'orderPositions', 'urgentPositions', 'unresolvedPositions', 'quantityTotal'];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(field => !allowed.includes(field))) throw new Error(`Сводка поставщика ${key} имеет неверный формат.`);
    if (typeof value.supplier !== 'string' || value.supplier.length > 100 || !['positions', 'orderPositions', 'urgentPositions', 'unresolvedPositions'].every(field => Number.isSafeInteger(value[field]) && value[field] >= 0) || !Number.isFinite(value.quantityTotal) || value.quantityTotal < 0) throw new Error(`Числа сводки поставщика ${key} неверны.`);
    return { supplier: value.supplier, positions: value.positions, orderPositions: value.orderPositions, urgentPositions: value.urgentPositions, unresolvedPositions: value.unresolvedPositions, quantityTotal: value.quantityTotal };
  };
  const item = (value, key) => {
    const strings = { code1c: 100, article: 100, name: 180, supplier: 100, warehouse: 100, category: 100, urgency: 24, unit: 24, stockStatus: 40, stockDate: 24, blockedReason: 400, explanation: 900 };
    const numbers = ['suggestedQuantity', 'currentQuantity', 'onHand', 'inboundOnTime', 'inboundLate', 'leadTimeDays', 'forecastDemand', 'annualGrowthPct', 'moq', 'packSize'];
    const allowed = [...Object.keys(strings), ...numbers, 'excluded', 'sources'];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(field => !allowed.includes(field))) throw new Error(`Позиция ${key} содержит неподдерживаемые поля.`);
    for (const [field, max] of Object.entries(strings)) if (value[field] != null && (typeof value[field] !== 'string' || value[field].length > max)) throw new Error(`Поле ${field} позиции ${key} слишком длинное или имеет неверный формат.`);
    for (const field of numbers) if (value[field] != null && (!Number.isFinite(value[field]) || Math.abs(value[field]) > 1e12)) throw new Error(`Показатель ${field} позиции ${key} неверен.`);
    if (typeof value.excluded !== 'boolean' || !Array.isArray(value.sources) || value.sources.length > 5 || value.sources.some(source => typeof source !== 'string' || source.length > 240)) throw new Error(`Источники позиции ${key} имеют неверный формат.`);
    return Object.fromEntries(allowed.filter(field => Object.hasOwn(value, field)).map(field => [field, field === 'sources' ? value.sources.slice() : value[field]]));
  };
  if (plan.asOf != null && (typeof plan.asOf !== 'string' || plan.asOf.length > 24)) throw new Error('Дата сводки имеет неверный формат.');
  const safePlan = {
    asOf: plan.asOf ?? null, datasetType: plan.datasetType,
    ...Object.fromEntries(requiredCounts.map(key => [key, plan[key]])), quantityTotal: plan.quantityTotal,
    suppliers: plan.suppliers.map(count), priorityItems: plan.priorityItems.map(item),
    selectedItem: plan.selectedItem == null ? null : item(plan.selectedItem, 'выбранной'),
  };
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 24_000) throw new Error('Размер аналитических данных превышает 24 КБ.');
  return { question: value.question.trim(), plan: safePlan };
}
