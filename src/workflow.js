function validateQuantity(row, value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1e9) throw new Error('Количество должно быть целым числом от 0 до 1 000 000 000.');
  if (value % row.packSize !== 0) throw new Error(`Количество должно быть кратно упаковке (${row.packSize}).`);
}
function snapshot(draft) {
  return JSON.stringify({ rows: draft.rows, options: draft.options, asOf: draft.asOf, datasetName: draft.datasetName, isDemo: draft.isDemo, id: draft.id, approvedAt: draft.approvedAt });
}
export function createDraft(result, dataset, options = {}) {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(), datasetName: dataset.name,
    asOf: dataset.asOf, isDemo: dataset.isDemo, status: 'draft',
    options: structuredClone(options), rows: structuredClone(result.rows).map(row => ({ ...row, quantity: row.suggestedQuantity })),
  };
}
export function updateQuantity(draft, rowId, value) {
  // Revoke approval even if an attempted edit is invalid.
  draft.status = 'draft'; delete draft.approvedAt; delete draft.approvalSnapshot;
  const row = draft.rows.find(item => item.id === rowId);
  if (!row) throw new Error('Строка рекомендации не найдена.');
  validateQuantity(row, value);
  row.quantity = value;
  return draft;
}
export function approveDraft(draft) {
  if (!draft.rows.length) throw new Error('Нет строк для утверждения.');
  draft.rows.forEach(row => validateQuantity(row, row.quantity));
  draft.status = 'approved'; draft.approvedAt = new Date().toISOString();
  draft.approvalSnapshot = snapshot(draft);
  return draft;
}
function csvCell(value) {
  let text = value == null ? '' : String(value);
  // Prevent formula injection when a user opens the export in a spreadsheet.
  if (/^[\s]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function exportDraftCsv(draft) {
  if (draft.status !== 'approved' || draft.approvalSnapshot !== snapshot(draft)) throw new Error('Утвердите текущую версию расчёта перед экспортом.');
  draft.rows.forEach(row => validateQuantity(row, row.quantity));
  const header = ['Набор данных', 'Демонстрационный', 'Дата расчёта', 'ID расчёта', 'Утверждено', 'Поставщик', 'Склад', 'Категория', 'Артикул', 'Товар', 'Единица', 'Срочность', 'Рекомендовано', 'Утверждённое количество', 'Остаток', 'В пути в горизонте', 'В пути позже', 'Срок поставки, дней', 'Упущенный спрос за историю', 'Исключено разовых продаж', 'Объяснение'];
  const labels = { critical: 'Критично', soon: 'Скоро', normal: 'Планово' };
  const rows = draft.rows.map(row => [draft.datasetName, draft.isDemo ? 'Да' : 'Нет', draft.asOf, draft.id, draft.approvedAt, row.supplierName, row.warehouseName, row.categoryName, row.productId, row.productName, row.unit, labels[row.urgency] ?? row.urgency, row.suggestedQuantity, row.quantity, row.onHand, row.inboundOnTime, row.inboundLate, row.leadTimeDays, row.lostDemand, row.outlierQuantity, row.explanation]);
  return '\uFEFF' + [header, ...rows].map(row => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
}
