import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraft, updateQuantity, approveDraft, exportDraftCsv, setRowExcluded } from '../src/workflow.js';

function fixture() {
  return createDraft({ rows: [{ id: 'P1@W1', productId: 'P1', productName: 'Кабель; "А"', supplierName: '=HYPERLINK("bad")', warehouseName: 'Склад', categoryName: 'Кабель', unit: 'м', urgency: 'critical', suggestedQuantity: 20, packSize: 10, onHand: 2, inboundOnTime: 5, inboundLate: 100, leadTimeDays: 7, lostDemand: 3, outlierQuantity: 50, explanation: 'Спрос 22 + буфер 5 − остаток 2 − поставка 5 = 20.' }] }, { name: 'Демо', asOf: '2026-09-23', isDemo: true });
}
test('полный цикл: расчёт → коррекция → утверждение → CSV с объяснением', () => {
  const draft = fixture();
  assert.throws(() => exportDraftCsv(draft), /Утвердите/);
  updateQuantity(draft, draft.rows[0].id, 30);
  approveDraft(draft);
  const csv = exportDraftCsv(draft);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"20";"30"'));
  assert.ok(csv.includes('Спрос 22'));
  assert.ok(csv.includes('"Кабель; ""А"""'));
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes('"Да"'));
  assert.ok(csv.includes('Утверждено'));
});
test('редактирование снимает утверждение, повторное утверждение разрешает экспорт', () => {
  const draft = fixture(); approveDraft(draft);
  updateQuantity(draft, draft.rows[0].id, 0);
  assert.equal(draft.status, 'draft');
  assert.throws(() => exportDraftCsv(draft), /Утвердите/);
  approveDraft(draft); assert.ok(exportDraftCsv(draft).includes('"20";"0"'));
});
test('даже прямое изменение утверждённых данных отклоняет экспорт', () => {
  const draft = fixture(); approveDraft(draft);
  draft.rows[0].quantity = 40;
  assert.throws(() => exportDraftCsv(draft), /Утвердите/);
});
test('демо-маркировка и метаданные входят в утверждённый снимок', () => {
  const draft = fixture(); approveDraft(draft);
  draft.isDemo = false;
  assert.throws(() => exportDraftCsv(draft), /Утвердите/);
});
test('ошибочная попытка коррекции снимает утверждение', () => {
  const draft = fixture(); approveDraft(draft);
  assert.throws(() => updateQuantity(draft, draft.rows[0].id, -1));
  assert.equal(draft.status, 'draft');
  assert.throws(() => exportDraftCsv(draft));
});
for (const value of [-1, 2.5, 21, NaN, Infinity, '20', 1e10]) {
  test(`невалидное количество ${value} отклоняется`, () => {
    const draft = fixture();
    assert.throws(() => updateQuantity(draft, draft.rows[0].id, value));
  });
}
test('нельзя утвердить пустой результат', () => {
  const draft = fixture(); draft.rows = [];
  assert.throws(() => approveDraft(draft), /Нет строк/);
});

test('MOQ и кратность независимы: минимум 25, упаковка 10, допустимы 0 или 30+', () => {
  const draft = fixture(); draft.rows[0].moq = 25;
  assert.throws(() => updateQuantity(draft, draft.rows[0].id, 20), /Минимальная/);
  assert.throws(() => updateQuantity(draft, draft.rows[0].id, 25), /кратно/);
  updateQuantity(draft, draft.rows[0].id, 30); approveDraft(draft);
  assert.ok(exportDraftCsv(draft).includes('MOQ'));
  updateQuantity(draft, draft.rows[0].id, 0); approveDraft(draft);
});
test('неизвестное количество нельзя утвердить, но менеджер может явно исключить строку без подмены нулём', () => {
  const draft = fixture();
  draft.rows[0].quantity = null; draft.rows[0].suggestedQuantity = null; draft.rows[0].onHand = null;
  draft.rows[0].blockedReason = 'Неизвестный остаток';
  assert.throws(() => approveDraft(draft));
  setRowExcluded(draft, draft.rows[0].id, true); approveDraft(draft);
  const csv = exportDraftCsv(draft);
  assert.ok(csv.includes('Исключено менеджером')); assert.ok(csv.includes('Неизвестный остаток'));
  setRowExcluded(draft, draft.rows[0].id, false);
  assert.throws(() => exportDraftCsv(draft));
  updateQuantity(draft, draft.rows[0].id, 30); approveDraft(draft);
  assert.ok(exportDraftCsv(draft).includes('Задано менеджером'));
});
test('неизвестные условия партии не разрешают положительное ручное количество', () => {
  const draft = fixture(); draft.rows[0].packSize = null;
  assert.throws(() => updateQuantity(draft, draft.rows[0].id, 10), /Неизвестна кратность/);
  draft.rows[0].packSize = 10; draft.rows[0].moq = null;
  assert.throws(() => updateQuantity(draft, draft.rows[0].id, 10), /Неизвестна минимальная/);
  updateQuantity(draft, draft.rows[0].id, 0); approveDraft(draft);
});

test('разные закупочные единицы нельзя обойти ручным количеством или утверждением', () => {
  const draft = fixture(); draft.rows[0].unitConversionRequired = true;
  assert.throws(() => updateQuantity(draft, draft.rows[0].id, 30), /коэффициент/);
  assert.throws(() => approveDraft(draft), /коэффициент/);
  setRowExcluded(draft, draft.rows[0].id, true); approveDraft(draft);
  assert.ok(exportDraftCsv(draft).includes('Исключено менеджером'));
  setRowExcluded(draft, draft.rows[0].id, false);
  updateQuantity(draft, draft.rows[0].id, 0); approveDraft(draft);
});
