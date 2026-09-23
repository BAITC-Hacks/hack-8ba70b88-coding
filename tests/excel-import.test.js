import test from 'node:test';
import assert from 'node:assert/strict';
import { importSupplierWorkbooks } from '../src/excel-import.js';

const row = (number, cells) => ({ number, cells });
const sheet = (name, rows) => ({ name, rows, merges: [], dimension: 'A1:BC100' });
const workbook = sheets => ({ sheets, date1904: false, warnings: [] });
function fixture(supplierId = 'iek', code = 'FAKE-01', article = 'ART-01') {
  const system = supplierId === 'systeme';
  const entry = (filename, rows) => ({ supplierId, filename, workbook: workbook([sheet('Данные', rows)]) });
  return [
    entry('MOQ.xlsx', [row(1, system ? { B: 'Номенклатура', C: 'Номенклатура.Код', D: 'Артикул', E: 'Кратность' } : { B: 'Код 1с', C: 'Артикул поставщика', D: 'Наименование', E: 'Мин. разр. к отгр.' }), row(2, system ? { B: 'Вымышленный товар', C: code, D: article, E: 6 } : { B: code, C: article, D: 'Вымышленный товар', E: 5 })]),
    entry('Динамика продаж_1990.xlsx', [row(1, { A: 'Дата', B: 'Номер', C: 'Документ', D: 'Код', E: 'Номенклатура', F: 'Ед.', G: 'Склад', H: 'Количество' }), row(2, { A: '01.01.2025 11:00:00', B: 'DOC-A', C: 'Расходная накладная DOC-A', D: code, E: 'Вымышленный товар', F: 'шт', G: 'Склад А', H: 10 }), row(3, { A: '15.02.2025 12:00:00', B: 'DOC-B', C: 'Расходная накладная DOC-B', D: code, E: 'Вымышленный товар', F: 'шт', G: 'Склад А', H: -2 }), row(4, { A: '22.03.2025', C: 'Расходная накладная DOC-C', D: code, E: 'Вымышленный товар', G: 'Склад А', H: 8 })]),
    entry('Ежемесячные остатки.xlsx', [row(1, { A: 'Номенклатура', B: 'Ед.', C: 'Номенклатура.Код', D: 'янв. 2025', E: 'февр. 2025', F: 'март 2025' }), row(2, system ? { D: 'Количество' } : { D: 'нач. остаток' }), row(3, { A: 'Вымышленный товар', B: 'шт', C: code, D: 12, E: 0 })]),
    entry('Ежемесячные продажи.xlsx', [row(1, system ? { A: 'Номенклатура', B: 'Номенклатура.Код', C: 'Артикул', D: 'Кратность', E: 'янв. 2025', F: 'февр. 2025', G: 'март 2025' } : { A: 'Номенклатура', B: 'Номенклатура.Код', C: 'янв. 2025', D: 'февр. 2025', E: 'март 2025' }), row(2, system ? { A: 'Вымышленный товар', B: code, C: article, D: 0, E: 10, F: -2, G: 8 } : { A: 'Вымышленный товар', B: code, C: 10, D: -2, E: 8 })]),
    entry('Сезонность.xlsx', [row(3, { A: 'год', B: 'янв' }), ...[2023, 2024, 2025].map((year, index) => row(index + 4, { A: year, ...Object.fromEntries(Array.from({ length: year === 2025 ? 3 : 12 }, (_, m) => [String.fromCharCode(66 + m), 100 + m * 10])) }))]),
    entry('Товары в пути 1990.xlsx', system ? [row(2, { B: 'Артикул поставщика', C: 'Код 1с', D: 'Наименование', E: 'Категория 2026', AX: 'Остаток', AY: 'Зарезервировано', AZ: 'Свободный остаток', BC: 'СЭ в пути 24.03' }), row(3, { B: article, C: code, D: 'Вымышленный товар', E: 'Тест', AT: 3, AU: 3, AX: 20, AY: 7, AZ: 13, BC: 6 })] : [row(1, { A: 'Код 1с', B: 'Артикул ИЭК', C: 'Наименование', D: 'Заказ от 15 марта 2025 (поступление до 01.04.2025)' }), row(2, { A: code, B: article, C: 'Вымышленный товар', D: 8 })]),
  ];
}

test('imports all six sources without adding monthly and detailed demand', () => {
  const data = importSupplierWorkbooks(fixture());
  assert.equal(data.schemaVersion, 2);
  assert.equal(data.products.length, 1);
  assert.equal(data.report.files.length, 6);
  assert.equal(data.products[0].monthlySales[0].quantity, 10);
  assert.equal(data.products[0].detailMonthly[0].positive, 10);
  assert.equal(data.products[0].detailMonthly[1].negative, -2);
  assert.equal(data.products[0].detailMonthly[1].corrections, 2);
  assert.equal(data.asOf, '2025-03-23');
  assert.equal(data.suppliers[0].detailPeriod.start, '2025-01-01');
  assert.equal(data.report.reconciliation.length, 2);
  assert.ok(data.report.reconciliation.every(r => r.status === 'scope-unconfirmed'));
  assert.equal(data.report.reconciliation.some(r => r.month === '2025-03'), false);
  assert.equal(JSON.stringify(data).includes('DOC-A'), false);
});

test('same code and article stay separate for different suppliers; MOQ is not a pack', () => {
  const data = importSupplierWorkbooks([...fixture(), ...fixture('systeme')]);
  assert.equal(data.products.length, 2);
  const iek = data.products.find(p => p.supplierId === 'iek');
  const system = data.products.find(p => p.supplierId === 'systeme');
  assert.equal(iek.moq, 5); assert.equal(iek.packSize, null);
  assert.equal(system.packSize, 6); assert.equal(system.moq, null);
  assert.ok(system.packSource.endsWith('E2'));
  assert.ok(data.report.issues.some(i => i.type === 'secondary-pack'));
});

test('free stock is retained once, reserve is informative and unknown dates remain unknown', () => {
  const product = importSupplierWorkbooks(fixture('systeme')).products[0];
  const free = product.stocks.find(s => s.basis === 'free');
  assert.equal(free.quantity, 13);
  assert.equal(free.reserve, 7);
  assert.equal(free.gross, 20);
  assert.equal(free.date, null);
  assert.equal(product.stocks.find(s => s.month === '2025-02').quantity, 0);
  assert.equal(product.stocks.find(s => s.month === '2025-03').quantity, null);
  assert.equal(product.stocks[0].basis, 'unknown-monthly');
  assert.equal(product.inbound[0].eta, null);
  assert.equal(product.inbound[0].etaMonthDay, '03-24');
  assert.equal(product.inbound[0].etaType, 'year-missing');
});

test('opening stocks and full inbound deadline come from content, not filenames', () => {
  const product = importSupplierWorkbooks(fixture()).products[0];
  assert.equal(product.stocks[0].date, '2025-01-01');
  assert.equal(product.stocks[0].basis, 'opening');
  assert.equal(product.inbound[0].eta, '2025-04-01');
  assert.equal(product.inbound[0].etaType, 'deadline');
});

test('missing cells and Excel errors are unknown, while numeric zero is confirmed', () => {
  const entries = fixture();
  entries[0].workbook.sheets[0].rows[1].cells.E = '#N/A';
  entries[3].workbook.sheets[0].rows[1].cells.C = '#VALUE!';
  entries[3].workbook.sheets[0].rows[1].cells.D = 0;
  const data = importSupplierWorkbooks(entries);
  assert.equal(data.products[0].moq, null);
  assert.equal(data.products[0].monthlySales[0].quantity, null);
  assert.equal(data.products[0].monthlySales[1].quantity, 0);
  assert.equal(data.report.issues.filter(i => i.type === 'invalid-number').length, 2);
});

test('historic negative corrections do not define the positive sales period; non-sale documents excluded', () => {
  const entries = fixture();
  entries[1].workbook.sheets[0].rows.push(row(5, { A: '01.01.2023', C: 'Расходная накладная HISTORIC', D: 'FAKE-01', E: 'Вымышленный товар', G: 'Склад А', H: -4 }), row(6, { A: '22.03.2025', C: 'Приходная накладная RETURN', D: 'FAKE-01', E: 'Вымышленный товар', G: 'Склад А', H: -3 }), row(7, { A: '01.04.2025', C: 'Заказ покупателя ORDER', D: 'FAKE-01', E: 'Вымышленный товар', G: 'Склад А', H: 300 }));
  const data = importSupplierWorkbooks(entries);
  assert.equal(data.suppliers[0].detailPeriod.start, '2025-01-01');
  assert.equal(data.asOf, '2025-03-23');
  assert.equal(data.report.excludedDocuments.length, 2);
  assert.equal(data.products[0].detailMonthly.reduce((s, r) => s + r.positive, 0), 18);
  assert.equal(data.products[0].detailMonthly.reduce((s, r) => s + r.negative, 0), -6);
  assert.ok(data.report.reconciliation.every(r => r.month.startsWith('2025')));
});

test('complete raw seasonality years and incomplete year are preserved with provenance', () => {
  const data = importSupplierWorkbooks(fixture());
  assert.deepEqual(data.suppliers[0].seasonalityYears.map(r => r.year), [2023, 2024, 2025]);
  assert.equal(data.suppliers[0].seasonalityYears[2].values[3], null);
  assert.equal(data.suppliers[0].seasonalityYears[0].values[11], 210);
  assert.match(data.suppliers[0].seasonalityYears[0].source, /B4$/);
});

test('unique article-only row joins code, ambiguous article does not merge different codes', () => {
  const entries = fixture();
  delete entries[5].workbook.sheets[0].rows[1].cells.A;
  let data = importSupplierWorkbooks(entries);
  assert.equal(data.products.length, 1);
  assert.equal(data.products[0].inbound.length, 1);
  entries[0].workbook.sheets[0].rows.push(row(3, { B: 'FAKE-02', C: 'ART-01', D: 'Другой вымышленный товар', E: 5 }));
  data = importSupplierWorkbooks(entries);
  assert.equal(data.products.length, 2);
  assert.equal(data.products.reduce((s, p) => s + p.inbound.length, 0), 0);
  assert.ok(data.report.issues.some(i => i.type === 'article-conflict'));
  assert.ok(data.report.issues.some(i => i.type === 'ambiguous-article'));
});

test('duplicate monthly quantity conflicts never add together; identical duplicates deduplicate', () => {
  const entries = fixture();
  const monthly = entries[3].workbook.sheets[0].rows;
  monthly.push(row(3, { ...monthly[1].cells, C: 12 }));
  const data = importSupplierWorkbooks(entries);
  assert.equal(data.products[0].monthlySales.length, 3);
  assert.equal(data.products[0].monthlySales[0].quantity, null);
  assert.equal(data.products[0].monthlySales[1].quantity, -2);
  assert.equal(data.report.duplicateRows, 2);
  assert.ok(data.report.issues.some(i => i.type === 'duplicate-conflict'));
});

test('auxiliary aggregate sheets listed but not counted as monthly item sales', () => {
  const entries = fixture();
  entries[3].workbook.sheets.push(entries[4].workbook.sheets[0]);
  const data = importSupplierWorkbooks(entries);
  assert.equal(data.products.length, 1);
  assert.equal(data.report.files[3].sheets.length, 2);
  assert.equal(data.report.files[3].sheets[1].status, 'not-used:duplicated aggregate');
});

test('entire product population is retained without 1000-product or daily-row expansion', () => {
  const entries = fixture();
  for (let i = 1; i <= 1200; i++) entries[0].workbook.sheets[0].rows.push(row(i + 2, { B: `FAKE-${i + 10}`, C: `ARTICLE-${i}`, D: `Синтетический товар ${i}`, E: 1 }));
  const data = importSupplierWorkbooks(entries);
  assert.equal(data.products.length, 1201);
  assert.equal(data.products.reduce((s, p) => s + p.detailMonthly.length, 0), 3);
  assert.equal(data.report.unmatched.length, 1200);
});

test('six profile types and valid headers are required; duplicate files fail explicitly', () => {
  assert.throws(() => importSupplierWorkbooks(fixture().slice(1)), /не хватает/);
  const entries = fixture();
  assert.throws(() => importSupplierWorkbooks([...entries, entries[0]]), /Повторный источник/);
  entries[0].workbook.sheets[0].rows[0].cells.E = 'Неизвестное поле';
  assert.throws(() => importSupplierWorkbooks(entries), /заголовками/);
});

test('only complete shared detail periods are reconciliation candidates, with traceable source ranges', () => {
  const entries = fixture();
  entries[1].workbook.sheets[0].rows[1].cells.A = '04.01.2025';
  entries[1].workbook.sheets[0].rows.push(row(5, { A: '20.02.2025', C: 'Расходная накладная FICTIVE', D: 'FAKE-01', E: 'Вымышленный товар', G: 'Склад А', H: 3 }));
  const data = importSupplierWorkbooks(entries);
  assert.deepEqual(data.report.reconciliation.map(r => r.month), ['2025-02']);
  const reconciliation = data.report.reconciliation[0];
  assert.match(reconciliation.detailSource, /H3:H5; фильтр:/);
  assert.match(reconciliation.monthlySource, /D2$/);
  assert.equal(reconciliation.detailNet, 1);
});

test('identical duplicate inbound rows do not double order quantities; separate columns retain their dates', () => {
  const entries = fixture();
  const rows = entries[5].workbook.sheets[0].rows;
  rows[0].cells.E = 'Партия поступление до 15.04.2025';
  rows[1].cells.E = 12;
  rows.push(row(3, { ...rows[1].cells }));
  const data = importSupplierWorkbooks(entries);
  assert.equal(data.products[0].inbound.length, 2);
  assert.equal(data.products[0].inbound.reduce((sum, r) => sum + r.quantity, 0), 20);
  assert.equal(data.products[0].inbound[1].eta, '2025-04-15');
  assert.ok(data.report.issues.some(r => r.type === 'duplicate-inbound'));
});

test('conflicting MOQ stays unknown and negative stocks are explicitly reported', () => {
  const entries = fixture();
  entries[0].workbook.sheets[0].rows.push(row(3, { B: 'FAKE-01', C: 'ART-01', D: 'Вымышленный товар', E: 6 }), row(4, { B: 'FAKE-01', C: 'ART-01', D: 'Вымышленный товар', E: 5 }));
  entries[2].workbook.sheets[0].rows[2].cells.D = -3;
  const data = importSupplierWorkbooks(entries);
  assert.equal(data.products[0].moq, null);
  assert.equal(data.products[0].stocks[0].quantity, -3);
  assert.ok(data.report.issues.some(r => r.type === 'negative-stock'));
  assert.ok(data.report.issues.some(r => r.type === 'constraint-conflict'));
});

test('explicit differing purchase/storage units require review without inventing conversion from the name', () => {
  const entries = fixture();
  entries[5].workbook.sheets[0].rows[1].cells.C = 'Вымышленный кабель 999м ЗАКУПАЮТСЯ БУХТАМИ, САДЯТСЯ МЕТРАЖОМ';
  const data = importSupplierWorkbooks(entries);
  assert.equal(data.products[0].unitConversionRequired, true);
  assert.equal(data.products[0].packSize, null);
  assert.equal(data.products[0].moq, 5);
  assert.match(data.products[0].unitConversionSource, /C2$/);
  assert.ok(data.report.issues.some(r => r.type === 'unit-conversion'));
});

test('blank-quantity detail-only product remains in the catalog; numeric spacer without a name is not a product', () => {
  const entries = fixture();
  entries[1].workbook.sheets[0].rows.push(row(5, { A: '12.02.2025', C: 'Расходная накладная EMPTY', D: 'FAKE-MISSING', E: 'Вымышленный товар без количества', F: 'шт', G: 'Склад А' }));
  entries[5].workbook.sheets[0].rows.push(row(3, { A: 1, B: 1 }));
  const data = importSupplierWorkbooks(entries);
  assert.equal(data.products.length, 2);
  const missingProduct = data.products.find(p => p.code === 'FAKE-MISSING');
  assert.ok(missingProduct);
  assert.deepEqual(missingProduct.detailMonthly, []);
  assert.equal(data.report.files.find(f => f.type === 'detail').products, 2);
  assert.equal(data.report.suppliers[0].detailProducts, 1);
  assert.equal(data.report.missingCells.detail, 1);
});
