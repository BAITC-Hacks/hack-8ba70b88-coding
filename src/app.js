import { createDemoData } from './demo.js';
import { validateDataset } from './validation.js';
import { calculateRecommendations } from './engine.js';
import { calculateRealRecommendations } from './real-engine.js';
import { createDraft, updateQuantity, setRowExcluded, approveDraft, exportDraftCsv } from './workflow.js';
import { buildAnalystPayload } from './analyst-payload.js';

const $ = (selector) => document.querySelector(selector);
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const date = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
let dataset = null;
let draft = null;
let calculation = null;
let uploadSequence = 0;
const invalidQuantities = new Map();
const invalidQuantityValues = new Map();
const PAGE_SIZE = 100;
let resultPage = 1;
let resultSearch = '';
let resultStatus = 'all';
let resultWarningsPage = 1;
let aiConfigured = false;
let aiModel = 'gpt-6-luna';
let aiInFlight = false;
let aiAbortController = null;
let aiAnalysis = null;
const reportPages = { issues: 1, reconciliation: 1, unmatched: 1, corrections: 1, excludedDocuments: 1 };
const isReal = () => dataset?.schemaVersion === 2;
const shownNumber = value => value == null || !Number.isFinite(Number(value)) ? 'Неизвестно' : number.format(value);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function formattedDate(value, compact = false) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : (compact ? shortDate : date).format(parsed);
}

function showNotice(message, type = 'info') {
  const notice = $('#notice');
  notice.textContent = message;
  notice.className = `notice ${type}`;
  notice.hidden = !message;
  notice.setAttribute('role', type === 'error' ? 'alert' : 'status');
}

function markAnalysisStale(reason = 'План или его параметры изменились. Запустите анализ снова.', refreshPreview = true) {
  if (aiAbortController) aiAbortController.abort();
  if (aiAnalysis) {
    aiAnalysis.stale = true;
    $('#ai-result-state').textContent = `Устаревший анализ. ${reason}`;
    $('#ai-result-state').className = 'ai-result-state stale';
    $('#ai-result-state').hidden = false;
  }
  if (refreshPreview) updateAnalystPreview(true);
}

function refreshAnalystAvailability() {
  const hasPlan = Boolean(draft?.rows?.length);
  $('#ai-analyze').disabled = !aiConfigured || !hasPlan || aiInFlight;
  $('#ai-selected-item').disabled = !hasPlan;
  $('#ai-question').disabled = !aiConfigured;
  $('#ai-consent-label').hidden = !hasPlan || !aiConfigured || draft?.isDemo === true;
  $('#ai-consent').disabled = !hasPlan || !aiConfigured || draft?.isDemo === true;
  $('#ai-config-state').textContent = aiConfigured
    ? `OpenAI настроен · модель ${aiModel}. AI-запрос выполняется только по кнопке.`
    : 'OpenAI не настроен. Расчёт и экспорт работают; задайте OPENAI_API_KEY в локальном .env, чтобы включить аналитика.';
}

function updateAnalystPreview(resetConsent = false) {
  const select = $('#ai-selected-item');
  const selectedId = select.value;
  if (resetConsent) $('#ai-consent').checked = false;
  if (!draft?.rows?.length) {
    $('#ai-data-preview').textContent = 'Сначала выполните расчёт; здесь появится точное содержимое запроса.';
  } else {
    try {
      const payload = buildAnalystPayload({ draft, selectedProductId: selectedId, question: $('#ai-question').value });
      $('#ai-data-preview').textContent = JSON.stringify(payload, null, 2);
    } catch (error) { $('#ai-data-preview').textContent = error.message; }
  }
  refreshAnalystAvailability();
}

function renderAnalystPanel() {
  const select = $('#ai-selected-item');
  const selectedId = select.value;
  const options = ['<option value="">Без отдельной позиции</option>'];
  if (draft?.rows) for (const row of draft.rows) {
    const id = String(row.id);
    const label = `${row.productCode || row.code || row.productId || 'Без кода'} · ${row.productName || 'Без названия'} · ${row.supplierName || ''}`;
    options.push(`<option value="${escapeHtml(id)}">${escapeHtml(label.slice(0, 260))}</option>`);
  }
  select.innerHTML = options.join('');
  if (selectedId && draft?.rows.some(row => String(row.id) === selectedId)) select.value = selectedId;
  updateAnalystPreview(false);
}

function setStep(activeStep) {
  ['data', 'calculate', 'review', 'export'].forEach((step, index) => {
    const element = $(`#step-${step}`);
    element.className = index < activeStep ? 'complete' : index === activeStep ? 'current' : '';
    if (index === activeStep) element.setAttribute('aria-current', 'step');
    else element.removeAttribute('aria-current');
    element.querySelector('span').textContent = index < activeStep ? '✓' : index + 1;
  });
}

function invalidateResult(message = '') {
  markAnalysisStale();
  draft = null;
  calculation = null;
  invalidQuantities.clear();
  invalidQuantityValues.clear();
  resultPage = 1;
  resultSearch = '';
  resultStatus = 'all';
  resultWarningsPage = 1;
  $('#results').hidden = true;
  $('#results').replaceChildren();
  $('#empty-results').hidden = false;
  $('#review-bar').hidden = true;
  updateAnalystPreview(false);
  setStep(dataset ? 1 : 0);
  if (message) showNotice(message);
}

function fillSelect(selector, items, allLabel) {
  const select = $(selector);
  select.replaceChildren(new Option(allLabel, 'all'));
  items.forEach((item) => select.add(new Option(item.name, item.id)));
}

function loadDataset(candidate, sourceName, fromLocalImport = false) {
  if (candidate?.schemaVersion === 2 && !fromLocalImport) throw new Error('Excel-наборы загружаются через локальный импорт папок. JSON предназначен для демонстрационной схемы.');
  if (fromLocalImport && (candidate?.schemaVersion !== 2 || !Array.isArray(candidate.products))) throw new Error('Локальный сервер вернул неподдерживаемый набор.');
  const validated = fromLocalImport ? candidate : validateDataset(candidate);
  dataset = validated;
  invalidateResult();
  fillSelect('#warehouse', dataset.warehouses, 'Все склады');
  fillSelect('#category', dataset.categories, 'Все категории');
  $('#supplier-field').hidden = !isReal();
  $('#supplier').disabled = !isReal();
  $('#real-settings').hidden = !isReal();
  $('#real-settings').querySelectorAll('input, select').forEach(input => { input.disabled = !isReal(); });
  $('#import-report').hidden = !isReal();
  $('#assumptions-confirmed').checked = false;
  if (isReal()) {
    fillSelect('#supplier', dataset.suppliers, 'Все поставщики');
    const warehouse = $('#warehouse');
    warehouse.options[0].value = 'global';
    warehouse.options[0].textContent = 'Общий разрез (все склады)';
    for (let i = warehouse.options.length - 1; i > 0; i--) if (warehouse.options[i].value === 'global') warehouse.remove(i);
    warehouse.value = 'global';
    const snapshot = new Date(`${dataset.asOf}T00:00:00Z`);
    snapshot.setUTCDate(snapshot.getUTCDate() - 1);
    $('#stock-snapshot-date').value = snapshot.toISOString().slice(0, 10);
    $('#eta-year').value = dataset.asOf.slice(0, 4);
    Object.keys(reportPages).forEach(key => { reportPages[key] = 1; });
    renderImportReport();
  }
  $('#settings-fields').disabled = false;
  $('#growth-percent').disabled = $('#growth-mode').value !== 'manual';
  $('#calculate-button').disabled = false;
  $('#asof-label').textContent = `Расчёт на ${formattedDate(dataset.asOf)}`;
  const name = dataset.name || dataset.metadata?.name || sourceName || 'Пользовательский набор';
  const isDemo = dataset.isDemo === true;
  $('#dataset-info').innerHTML = `<div><div class="dataset-title">${escapeHtml(name)} <span class="badge ${isDemo ? 'badge-demo' : ''}">${isDemo ? 'ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ' : isReal() ? 'РЕАЛЬНЫЕ EXCEL · ЛОКАЛЬНО' : 'ЛОКАЛЬНЫЙ ФАЙЛ'}</span></div><p class="dataset-description">${integer.format(dataset.products.length)} товаров · ${integer.format(dataset.warehouses.filter(item => item.id !== 'global').length)} складов в источниках · История с ${escapeHtml(formattedDate(dataset.historyStart))}${isDemo ? ' · Воспроизводимый синтетический набор, не данные компании' : ''}</p></div><span class="dataset-check" aria-label="Импорт завершён">✓</span>`;
  $('#dataset-info').hidden = false;
  $('.data-panel').classList.add('loaded');
  $('#demo-button').innerHTML = '<span aria-hidden="true">✦</span> Загрузить демо';
  $('#upload-button').innerHTML = '<span aria-hidden="true">↑</span> Другой JSON-файл';
  $('#growth-help').innerHTML = `<span aria-hidden="true">i</span>${isReal() ? 'Рост оценивается после удаления сезонности. Ручной прогноз заменяет исторический. Подробные и месячные продажи не суммируются.' : 'Индексы сезонности берутся из категории, устойчивый рост — из истории. Ручной прогноз заменяет исторический рост.'}`;
  showNotice(isDemo ? 'Демонстрационный набор готов. В нём есть сезонность, рост, дефицит, разовые крупные продажи и регулярные закупки крупных клиентов.' : isReal() ? 'Все найденные источники обработаны. Откройте отчёт импорта, проверьте допущения и запустите расчёт.' : 'Файл проверен и загружен. Выберите параметры и запустите расчёт.', 'success');
  renderAnalystPanel();
}

function download(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function sourceText(value) {
  if (value == null) return 'Неизвестно';
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  if (Array.isArray(value)) return value.map(sourceText).join('; ');
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}: ${sourceText(item)}`).join(' · ');
  const labels = { 'scope-unconfirmed': 'Охват выгрузок не подтверждён', 'in-horizon': 'В горизонте', overdue: 'Просрочена', 'after-horizon': 'После горизонта', 'unknown-date': 'Дата неизвестна', 'global-scope': 'Общий разрез, не распределено по складам', warning: 'Предупреждение', error: 'Ошибка', info: 'Информация' };
  return Object.hasOwn(labels, value) ? labels[value] : String(value);
}

function reportTable(items, columns) {
  return `<div class="table-scroll"><table class="report-table"><thead><tr>${columns.map(([, label]) => `<th scope="col">${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>${items.map(item => `<tr>${columns.map(([key]) => `<td>${escapeHtml(sourceText(item[key]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function reportPageMarkup(key, title, items, columns) {
  if (!items?.length) return `<p class="report-empty">${escapeHtml(title)}: нет записей.</p>`;
  const totalPages = Math.ceil(items.length / PAGE_SIZE);
  reportPages[key] = Math.min(reportPages[key] || 1, totalPages);
  const page = reportPages[key];
  const start = (page - 1) * PAGE_SIZE;
  return `<details class="report-section"><summary>${escapeHtml(title)} · ${integer.format(items.length)}</summary><div class="pagination"><button type="button" class="button button-secondary" data-report-page="${key}" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>Назад</button><span>${integer.format(start + 1)}–${integer.format(Math.min(start + PAGE_SIZE, items.length))} из ${integer.format(items.length)} · страница ${page} / ${totalPages}</span><button type="button" class="button button-secondary" data-report-page="${key}" data-page="${page + 1}" ${page === totalPages ? 'disabled' : ''}>Далее</button></div>${reportTable(items.slice(start, start + PAGE_SIZE), columns)}</details>`;
}

function renderImportReport() {
  const report = dataset.importReport || dataset.report || {};
  const sourceTypes = { moq: 'Минимальная партия / кратность', monthly: 'Ежемесячные продажи', stocks: 'Ежемесячные остатки', detail: 'Динамика продаж', inbound: 'Товары в пути', seasonality: 'Сезонность' };
  const openSections = [...$('#import-report-content').querySelectorAll('details[open]')].map(item => item.querySelector('summary')?.textContent);
  $('#import-report-content').innerHTML = `<div class="report-intro"><p><strong>${integer.format(report.fileCount ?? report.files?.length ?? 0)} файлов · ${integer.format(report.productCount ?? dataset.products.length)} товаров.</strong> Товары сопоставлены внутри поставщика по коду 1С и артикулам. Полный отчёт сохраняется локально; все записи доступны на страницах.</p><button type="button" id="download-import-report" class="button button-secondary">Скачать полный отчёт JSON</button></div>
    ${report.suppliers?.length ? reportTable(report.suppliers, [['name', 'Поставщик'], ['files', 'Файлов'], ['productCount', 'Товаров'], ['monthlyProducts', 'Месячные продажи'], ['detailProducts', 'Подробные продажи'], ['stockProducts', 'Остатки'], ['inboundProducts', 'В пути'], ['unknownPack', 'Неизвестная кратность'], ['unknownMoq', 'Неизвестная минимальная партия']]) : ''}
    <details class="report-section" open><summary>Обработанные файлы и листы</summary>${(report.files || []).map(file => `<article class="report-file"><h4>${escapeHtml(file.name)}</h4><p>${escapeHtml(file.supplierId)} · ${escapeHtml(sourceTypes[file.type] || file.type)} · ${integer.format(file.rowCount || 0)} строк · ${integer.format(file.products || 0)} товаров · период: ${escapeHtml(formattedDate(file.periodStart))} — ${escapeHtml(formattedDate(file.periodEnd))}</p>${(file.sheets || []).map(sheet => `<div class="report-sheet"><strong>${escapeHtml(sheet.name)}</strong> · ${integer.format(sheet.rows || 0)} строк · ${sheet.status === 'used' ? 'использован' : sheet.status === 'not-used:duplicated aggregate' ? 'не используется: повторная агрегированная таблица' : `не используется: ${escapeHtml(sheet.status)}`}<details><summary>Заголовки столбцов</summary><pre>${escapeHtml(JSON.stringify(sheet.headers, null, 2))}</pre></details></div>`).join('')}</article>`).join('')}</details>
    <div class="report-summary"><p>Дата недатированного среза: <strong>${report.snapshotDate ? escapeHtml(formattedDate(report.snapshotDate)) : 'не подтверждена источником'}</strong>. Отдельные даты поступления и периоды определяются по содержимому файлов.</p><p>Пропущенные строки: ${escapeHtml(sourceText(report.skippedRows ?? 0))} · Повторы: ${escapeHtml(sourceText(report.duplicateRows ?? 0))} · Отрицательные корректировки: ${integer.format(report.corrections?.length || 0)} · Исключённые движения документов: ${integer.format(report.excludedDocuments?.length || 0)}</p><details><summary>Пропуски ячеек по типам источников</summary><pre>${escapeHtml(JSON.stringify(report.missingCells || {}, null, 2))}</pre></details></div>
    ${report.assumptionsRequired?.length ? `<div class="warnings"><strong>Ограничения и необходимые допущения</strong><ul>${report.assumptionsRequired.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}
    ${reportPageMarkup('issues', 'Замечания импорта', report.issues, [['severity', 'Уровень'], ['productId', 'Товар'], ['source', 'Источник'], ['message', 'Описание']])}
    ${reportPageMarkup('unmatched', 'Неполное сопоставление источников', report.unmatched, [['productId', 'Товар'], ['missingSources', 'Не найдены источники']])}
    ${reportPageMarkup('corrections', 'Возвраты и отрицательные корректировки отдельно', report.corrections, [['productId', 'Товар'], ['month', 'Месяц'], ['warehouseId', 'Склад'], ['negative', 'Отрицательные движения'], ['returns', 'Распознанные возвраты'], ['corrections', 'Прочие корректировки'], ['source', 'Источник']])}
    ${reportPageMarkup('excludedDocuments', 'Движения документов, не вошедшие в продажи', report.excludedDocuments, [['productId', 'Товар'], ['date', 'Дата'], ['quantity', 'Количество'], ['documentType', 'Тип документа'], ['source', 'Источник']])}
    <p class="report-explainer">Сверка продаж сопоставляет только совпадающие месяцы в общем разрезе. Статус «scope-unconfirmed» означает, что совпадение охвата выгрузок не подтверждено; расхождение не прибавляется к спросу. Отрицательные движения хранятся отдельно.</p>
    ${reportPageMarkup('reconciliation', 'Сверка подробных и месячных продаж', report.reconciliation, [['productId', 'Товар'], ['month', 'Месяц'], ['detailNet', 'Динамика, нетто'], ['monthlyNet', 'Месячные, нетто'], ['difference', 'Разница'], ['status', 'Статус охвата']])}`;
  for (const section of $('#import-report-content').querySelectorAll('details')) if (openSections.includes(section.querySelector('summary')?.textContent)) section.open = true;
}

$('#import-report-content').addEventListener('click', event => {
  if (event.target.closest('#download-import-report')) download(JSON.stringify(dataset.importReport || dataset.report, null, 2), `otchet-importa-${dataset.asOf}.json`, 'application/json;charset=utf-8');
  const button = event.target.closest('[data-report-page]');
  if (!button) return;
  reportPages[button.dataset.reportPage] = Number(button.dataset.page);
  renderImportReport();
});

function selectedOptions() {
  const annualGrowthPct = Number($('#growth-percent').value);
  if ($('#growth-mode').value === 'manual' && ($('#growth-percent').value.trim() === '' || !Number.isFinite(annualGrowthPct) || annualGrowthPct < -90 || annualGrowthPct > 200)) {
    throw new Error('Укажите годовой прирост от −90 до 200 %.');
  }
  const options = { warehouseId: $('#warehouse').value, categoryId: $('#category').value, growthMode: $('#growth-mode').value, annualGrowthPct };
  if (!isReal()) return options;
  const numeric = (selector, label, min, max) => {
    const value = Number($(selector).value);
    if ($(selector).value.trim() === '' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${label}: укажите целое число от ${min} до ${max}.`);
    return value;
  };
  if (!$('#assumptions-confirmed').checked) throw new Error('Проверьте параметры и подтвердите допущения для реальных данных.');
  return { ...options, supplierId: $('#supplier').value,
    leadTimeDays: numeric('#lead-days', 'Срок нового заказа', 0, 730), reviewDays: numeric('#review-days', 'Период между заказами', 1, 365), safetyDays: numeric('#safety-days', 'Страховой запас', 0, 365), lookbackMonths: numeric('#lookback-months', 'История спроса', 1, 36),
    seasonalityMode: $('#seasonality-mode').value, salesSource: $('#sales-source').value, stockMode: $('#stock-mode').value, stockSnapshotDate: $('#stock-snapshot-date').value,
    allowStaleStock: $('#allow-stale-stock').checked, unknownStock: $('#unknown-stock').value, monthlyBlanks: $('#monthly-blanks').value,
    fallbackPackSize: numeric('#fallback-pack', 'Кратность при отсутствии', 1, 1000000), fallbackMoq: numeric('#fallback-moq', 'Минимальная партия при отсутствии', 0, 1000000), etaYear: numeric('#eta-year', 'Год поступления', 2000, 2100),
    confirmDetailScope: $('#confirm-detail-scope').checked, includePartialMonth: $('#include-partial-month').checked, assumptionsConfirmed: true,
  };
}

function totals() {
  const rows = draft?.rows.filter(row => !row.excluded) || [];
  return {
    ordered: rows.filter((row) => row.quantity > 0).length,
    suppliers: new Set(rows.filter((row) => row.quantity > 0).map((row) => row.supplierId)).size,
    changed: rows.filter((row) => row.quantity !== row.suggestedQuantity).length,
    critical: rows.filter((row) => row.urgency === 'critical').length,
    lostRows: rows.filter((row) => row.lostDemand > 0).length,
    outlierCount: rows.reduce((sum, row) => sum + (row.outlierCount || 0), 0),
    blocked: rows.filter(row => row.quantity == null || (row.blockedReason && !row.manualDecision)).length,
    excluded: draft?.rows.filter(row => row.excluded).length || 0,
  };
}

function rowMarkup(row, index) {
  const key = `row-${index}`;
  const urgency = { critical: 'Срочно', soon: 'В ближайшее время', normal: 'Планово' };
  const urgencyCode = Object.hasOwn(urgency, row.urgency) ? row.urgency : 'normal';
  const unit = escapeHtml(row.unit || 'шт.');
  const auditMarkup = `${row.recurringBulkCount > 0 ? `<p class="numeric-meta">Сохранено регулярных крупных заказов: ${escapeHtml(integer.format(row.recurringBulkCount))}. Они включены в базовый спрос.</p>` : ''}${row.excludedOutliers?.length ? `<details class="numeric-meta"><summary>Проверить исключённые разовые заказы (${escapeHtml(integer.format(row.excludedOutliers.length))})</summary><ul>${row.excludedOutliers.map((event) => `<li>${escapeHtml(formattedDate(event.date))} · Клиент ${escapeHtml(event.customerId)} · ${escapeHtml(number.format(event.quantity))} ${unit} · порог выброса ${escapeHtml(number.format(event.threshold))} ${unit}</li>`).join('')}</ul></details>` : ''}`;
  return `<tr data-row="${escapeHtml(row.id)}"><td><div class="product-name">${escapeHtml(row.productName)}</div><div class="product-meta">${escapeHtml(row.productId)} · ${escapeHtml(row.categoryName)}</div><div class="product-meta">${escapeHtml(row.warehouseName)}</div><button class="explain-button" type="button" data-explain="${key}" aria-expanded="false" aria-controls="${key}-explanation"><span aria-hidden="true">›</span> Почему столько?</button></td><td><div class="numeric-value">${number.format(row.baseDailyDemand)}</div><div class="numeric-meta">${unit} / день</div><div class="numeric-meta">Рост: ${row.annualGrowthPct > 0 ? '+' : ''}${number.format(row.annualGrowthPct)} % / год</div></td><td><div class="numeric-value">${number.format(row.onHand)} <span class="numeric-meta">${unit}</span></div><div class="numeric-meta incoming">+ ${number.format(row.inboundOnTime)} в горизонте</div>${row.inboundLate > 0 ? `<div class="late-stock">${number.format(row.inboundLate)} поздно / просрочено</div>` : ''}<div class="numeric-meta">Поставка: ${number.format(row.leadTimeDays)} дн.</div></td><td><div class="quantity-box"><input class="quantity-input" id="${key}-quantity" data-quantity="${escapeHtml(row.id)}" type="number" min="0" step="${escapeHtml(row.packSize)}" value="${escapeHtml(row.quantity)}" aria-label="Количество заказа: ${escapeHtml(row.productName)}, ${escapeHtml(row.warehouseName)}" aria-describedby="${key}-hint ${key}-error" /><span class="quantity-unit">${unit}</span></div><div id="${key}-hint" class="quantity-hint">Кратно ${number.format(row.packSize)} · расчёт ${number.format(row.suggestedQuantity)}</div><div id="${key}-error" class="quantity-error" hidden></div></td><td><span class="urgency urgency-${urgencyCode}">${row.suggestedQuantity === 0 && urgencyCode === 'normal' ? 'Запас достаточен' : urgency[urgencyCode]}</span><div class="stockout-label">${row.stockoutDate ? `Риск дефицита:<br />${escapeHtml(formattedDate(row.stockoutDate, true))}` : 'Без дефицита в горизонте'}</div></td></tr><tr class="explanation-row" id="${key}-explanation" hidden><td colspan="5"><div class="explanation"><div class="explanation-title">ЧИСЛОВОЕ ОБОСНОВАНИЕ</div><p class="explanation-text">${escapeHtml(row.explanation)}</p><div class="explanation-facts"><span>Спрос на горизонт: ${number.format(row.forecastDemand)} ${unit}</span><span>Страховой запас: ${number.format(row.safetyStock)} ${unit}</span><span>Упущенный спрос: ≈ ${number.format(row.lostDemand)} ${unit}</span><span>Исключено выбросов: ${integer.format(row.outlierCount)} (${number.format(row.outlierQuantity)} ${unit})</span></div>${auditMarkup}${row.warnings?.length ? `<div class="row-warnings">${row.warnings.map(escapeHtml).join('<br />')}</div>` : ''}</div></td></tr>`;
}

function renderDemoResults() {
  const total = totals();
  const groups = new Map();
  draft.rows.forEach((row, index) => {
    if (!groups.has(row.supplierId)) groups.set(row.supplierId, { name: row.supplierName, rows: [] });
    groups.get(row.supplierId).rows.push({ row, index });
  });
  $('#results').innerHTML = `<div class="results-heading"><div><h2 id="results-title">План закупок</h2><p>Проверьте количество в каждой строке и утвердите итоговый план.</p></div><span class="results-count">${draft.isDemo ? 'Демонстрационный расчёт' : 'Расчёт по вашим данным'}</span></div><div class="metrics"><div class="metric featured"><div class="metric-label"><span class="metric-dot"></span>Рекомендовано к заказу</div><div class="metric-value">${integer.format(draft.rows.filter((row) => row.suggestedQuantity > 0).length)} <small>позиций</small></div><p class="metric-caption">Из ${integer.format(draft.rows.length)} позиций в расчёте</p></div><div class="metric critical"><div class="metric-label"><span class="metric-dot"></span>Требуют внимания</div><div class="metric-value">${integer.format(total.critical)} <small>срочных</small></div><p class="metric-caption">Риск дефицита до новой поставки</p></div><div class="metric"><div class="metric-label"><span class="metric-dot"></span>Восстановлен спрос</div><div class="metric-value">${integer.format(total.lostRows)} <small>позиций</small></div><p class="metric-caption">С оценкой продаж в дни дефицита</p></div><div class="metric"><div class="metric-label"><span class="metric-dot"></span>Исключены выбросы</div><div class="metric-value">${integer.format(total.outlierCount)} <small>продаж</small></div><p class="metric-caption">Разовые крупные заказы</p></div></div><p class="results-note"><span aria-hidden="true">↳</span><span>Рекомендации сгруппированы по поставщикам. <strong>«Почему столько?»</strong> раскрывает формулу, восстановленный спрос и исключения. Все количества округлены до упаковки.</span></p>${calculation.warnings?.length ? `<div class="warnings"><strong>Обратите внимание</strong><ul>${calculation.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></div>` : ''}${groups.size ? [...groups.values()].map((group) => `<section class="supplier" aria-label="Поставщик ${escapeHtml(group.name)}"><div class="supplier-heading"><div class="supplier-identity"><span class="supplier-symbol" aria-hidden="true">▤</span><div><h3>${escapeHtml(group.name)}</h3><p>Поставщик · ${integer.format(group.rows.length)} позиций</p></div></div><span class="supplier-meta">${integer.format(group.rows.filter(({ row }) => row.suggestedQuantity > 0).length)} к пополнению</span></div><div class="table-scroll"><table><caption class="sr-only">Рекомендации: ${escapeHtml(group.name)}</caption><thead><tr><th scope="col">Товар / склад</th><th scope="col">Базовый спрос</th><th scope="col">Остаток и в пути</th><th scope="col">Заказать</th><th scope="col">Приоритет</th></tr></thead><tbody>${group.rows.map(({ row, index }) => rowMarkup(row, index)).join('')}</tbody></table></div></section>`).join('') : '<div class="no-recommendations"><h3>В выбранной группе нет товаров</h3><p>Измените склад или категорию и повторите расчёт.</p></div>'}<p class="warning-footnote">Оценка упущенного спроса — расчётное предположение. Исторические выбросы и сезонность доступны в пояснении каждой строки. Экспорт — универсальный CSV; совместимость с форматом 1С не заявляется.</p>`;
  $('#results').hidden = false;
  $('#empty-results').hidden = true;
  renderReviewBar();
  renderAnalystPanel();
  setStep(2);
}

function realRowMarkup(row, index) {
  const key = `row-${index}`;
  const unit = escapeHtml(row.unit || 'шт.');
  const unresolved = row.quantity == null || (row.blockedReason && !row.manualDecision);
  const labels = { critical: 'Срочно', soon: 'В ближайшее время', normal: 'Планово', blocked: 'Нет расчёта' };
  const urgency = Object.hasOwn(labels, row.urgency) ? row.urgency : 'normal';
  const error = invalidQuantities.get(String(row.id));
  const value = invalidQuantityValues.get(String(row.id)) ?? row.quantity ?? '';
  return `<tr data-row="${escapeHtml(row.id)}" class="${row.excluded ? 'row-excluded' : ''}"><td><div class="product-name">${escapeHtml(row.productName)}</div><div class="product-meta">Код 1С: ${escapeHtml(row.productCode || row.code || 'не указан')} · Артикул: ${escapeHtml(row.article || 'не указан')}</div><div class="product-meta">${escapeHtml(row.categoryName)} · ${escapeHtml(row.warehouseName)}</div><button class="explain-button" type="button" data-explain="${key}" data-facts-row="${escapeHtml(row.id)}" aria-expanded="false" aria-controls="${key}-explanation"><span aria-hidden="true">›</span> Почему столько? Числа и источники</button></td>
    <td><div class="numeric-value">${shownNumber(row.baseDailyDemand)}</div><div class="numeric-meta">${unit} / день</div><div class="numeric-meta">Рост: ${row.annualGrowthPct > 0 ? '+' : ''}${shownNumber(row.annualGrowthPct)} % / год</div></td>
    <td><div class="numeric-value ${row.onHand == null ? 'unknown-value' : ''}">${shownNumber(row.onHand)} ${row.onHand != null ? `<span class="numeric-meta">${unit}</span>` : ''}</div><div class="numeric-meta">${row.stockStatus === 'assumed-zero' ? 'Ноль по допущению' : row.onHand == null ? 'Нет подтверждённого остатка' : `Срез: ${escapeHtml(formattedDate(row.stockDate, true))}`}</div><div class="numeric-meta incoming">+ ${shownNumber(row.inboundOnTime)} в горизонте</div>${row.inboundLate > 0 ? `<div class="late-stock">${shownNumber(row.inboundLate)} поздно / просрочено</div>` : ''}<div class="numeric-meta">Новый заказ: ${shownNumber(row.leadTimeDays)} дн.</div></td>
    <td><div class="quantity-box"><input class="quantity-input ${row.manualDecision ? 'edited' : ''}" id="${key}-quantity" data-quantity="${escapeHtml(row.id)}" type="number" min="0" step="${escapeHtml(row.packSize ?? 1)}" ${row.packSize == null || row.moq == null || row.unitConversionRequired ? 'max="0"' : ''} value="${escapeHtml(value)}" placeholder="Нет расчёта" ${row.excluded ? 'disabled' : ''} aria-invalid="${Boolean(error)}" aria-label="Количество заказа: ${escapeHtml(row.productName)}" aria-describedby="${key}-hint ${key}-error" /><span class="quantity-unit">${unit}</span></div><div id="${key}-hint" class="quantity-hint">Кратность: ${shownNumber(row.packSize)} · мин. партия: ${shownNumber(row.moq)}<br />Расчёт: ${row.suggestedQuantity == null ? 'нет расчёта' : shownNumber(row.suggestedQuantity)}${row.unitConversionRequired ? '<br />Нужна проверка единиц. Можно исключить строку или отказаться, указав 0.' : ''}</div><div id="${key}-error" class="quantity-error" ${!error ? 'hidden' : ''}>${escapeHtml(error)}</div><span class="manual-status numeric-meta">${row.manualDecision ? 'Ручное решение менеджера' : ''}</span><label class="exclude-row"><input type="checkbox" data-excluded="${escapeHtml(row.id)}" ${row.excluded ? 'checked' : ''} /> Исключить из заказа</label></td>
    <td><span class="urgency urgency-${urgency}">${row.excluded ? 'Исключено' : row.manualDecision && row.blockedReason ? 'Ручное решение' : labels[urgency]}</span><div class="stockout-label">${row.blockedReason ? escapeHtml(row.blockedReason) : row.stockoutDate ? `Риск дефицита: ${escapeHtml(formattedDate(row.stockoutDate, true))}` : 'Нет выявленного дефицита в горизонте'}</div></td></tr>
    <tr class="explanation-row" id="${key}-explanation" hidden><td colspan="5"><div class="explanation"><div class="explanation-title">ЧИСЛОВОЕ ОБОСНОВАНИЕ · ${escapeHtml(formattedDate(dataset.asOf))}</div><p class="explanation-text">${escapeHtml(row.explanation)}</p><div class="explanation-facts"><span>Спрос на горизонт: ${shownNumber(row.forecastDemand)} ${unit}</span><span>Страховой запас: ${shownNumber(row.safetyStock)} ${unit}</span><span>Упущенный спрос: неизвестен — нет ежедневных остатков</span><span>Исключено разовых продаж: ${shownNumber(row.outlierQuantity)} ${unit}</span></div>${row.warnings?.length ? `<div class="row-warnings">${row.warnings.map(escapeHtml).join('<br />')}</div>` : ''}<div class="source-facts" data-facts-content="${escapeHtml(row.id)}"></div></div></td></tr>`;
}

function renderSourceFacts(row, target) {
  if (target.dataset.loaded) return;
  const facts = row.sourceFacts || {};
  const stock = facts.stock;
  const months = facts.salesMonths || [];
  const inbound = facts.inbound || [];
  target.innerHTML = `<h4>Исходные значения и даты</h4><p>База спроса: ${facts.salesSource === 'detail' ? 'подробная динамика продаж' : 'месячные продажи'} · период ${escapeHtml(formattedDate(facts.salesPeriod?.start))} — ${escapeHtml(formattedDate(facts.salesPeriod?.end))}.</p>
    <p>Исходный остаток: ${shownNumber(stock?.quantity)}${stock?.month ? ` · месяц снимка: ${escapeHtml(stock.month)}` : ''}${stock && Object.hasOwn(stock, 'gross') ? ` · общий остаток: ${shownNumber(stock.gross)}` : ''}${stock && Object.hasOwn(stock, 'reserve') ? ` · резерв: ${shownNumber(stock.reserve)}` : ''}. ${stock?.basis === 'free' ? 'Источник уже содержит свободный остаток; резерв повторно не вычитается.' : 'Свободная часть месячного остатка не подтверждена.'}</p><p>Остаток в расчёте: ${shownNumber(row.onHand)} · дата ${escapeHtml(formattedDate(facts.stockDate || row.stockDate))}${stock?.assumedDate ? ' (дата принята по вашему допущению)' : ''} · источник ${escapeHtml(sourceText(stock?.source || stock?.sources))}.</p>
    <p>Кратность: ${shownNumber(row.packSize)}${facts.pack?.assumed ? ' (допущение)' : ''} · ${escapeHtml(sourceText(facts.pack?.source))}. Минимальная партия: ${shownNumber(row.moq)}${facts.moq?.assumed ? ' (допущение)' : ''} · ${escapeHtml(sourceText(facts.moq?.source))}.</p>
    ${months.length ? `<details open><summary>Месяцы в базовом спросе (${months.length})</summary>${reportTable(months, [['month', 'Месяц'], ['quantity', 'Исходные продажи'], ['negative', 'Отрицательные движения'], ['demandQuantity', 'Спрос в расчёте'], ['days', 'Дней'], ['factor', 'Индекс сезонности'], ['incomplete', 'Неполный месяц'], ['assumedZero', 'Ноль по допущению'], ['sources', 'Источники']])}</details>` : '<p>Нет пригодных месяцев для базового спроса.</p>'}
    ${inbound.length ? `<details><summary>Партии в пути (${inbound.length})</summary>${reportTable(inbound.map(item => ({ ...item, assumedYear: item.assumedYear ? 'Да' : 'Нет' })), [['quantity', 'Количество'], ['effectiveEta', 'Дата в расчёте'], ['assumedYear', 'Год по допущению'], ['use', 'Применение'], ['source', 'Источник']])}</details>` : '<p>Партии в пути для этого разреза не найдены.</p>'}
    <details><summary>Сезонность и отдельные корректировки</summary><p>Полные годы сезонности: ${escapeHtml(sourceText(facts.seasonality?.years))}. Источники: ${escapeHtml(sourceText(facts.seasonality?.sources))}.</p><pre>${escapeHtml(JSON.stringify({ 'Индексы сезонности': facts.seasonality?.factors, 'Возвраты и отрицательные корректировки': facts.detailAdjustments, 'Принятые допущения': facts.assumptions }, null, 2))}</pre></details>
    <details><summary>Все ссылки на источники (${row.sources?.length || 0})</summary><ul>${(row.sources || []).map(source => `<li>${escapeHtml(sourceText(source))}</li>`).join('')}</ul></details><button class="text-button" type="button" data-download-facts="${escapeHtml(row.id)}">Скачать исходные числа и источники строки (JSON) ↓</button>`;
  target.dataset.loaded = 'true';
}

function filteredResultRows() {
  const search = resultSearch.trim().toLocaleLowerCase('ru');
  return draft.rows.map((row, index) => ({ row, index })).filter(({ row }) => {
    const unresolved = row.quantity == null || (row.blockedReason && !row.manualDecision);
    if (resultStatus === 'blocked' && (!unresolved || row.excluded)) return false;
    if (resultStatus === 'ready' && (unresolved || row.excluded)) return false;
    if (resultStatus === 'excluded' && !row.excluded) return false;
    return !search || [row.productName, row.productCode, row.code, row.productId, row.article, row.supplierName, row.categoryName].some(value => String(value ?? '').toLocaleLowerCase('ru').includes(search));
  });
}

function renderResults() {
  if (!isReal()) { renderDemoResults(); return; }
  const total = totals();
  const warningsOpen = $('#calculation-warnings')?.open === true;
  const warnings = calculation.warnings || [];
  const warningPages = Math.max(1, Math.ceil(warnings.length / PAGE_SIZE));
  resultWarningsPage = Math.min(resultWarningsPage, warningPages);
  const warningStart = (resultWarningsPage - 1) * PAGE_SIZE;
  const filtered = filteredResultRows();
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  resultPage = Math.min(resultPage, pages);
  const start = (resultPage - 1) * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);
  const groups = new Map();
  for (const item of visible) {
    if (!groups.has(item.row.supplierId)) groups.set(item.row.supplierId, { name: item.row.supplierName, rows: [] });
    groups.get(item.row.supplierId).rows.push(item);
  }
  const pagination = `<div class="pagination results-pagination"><button type="button" class="button button-secondary" data-result-page="${resultPage - 1}" ${resultPage === 1 ? 'disabled' : ''}>← Назад</button><span>${filtered.length ? integer.format(start + 1) : 0}–${integer.format(Math.min(start + PAGE_SIZE, filtered.length))} из ${integer.format(filtered.length)} · страница ${resultPage} / ${pages}</span><button type="button" class="button button-secondary" data-result-page="${resultPage + 1}" ${resultPage === pages ? 'disabled' : ''}>Далее →</button></div>`;
  $('#results').innerHTML = `<div class="results-heading"><div><h2 id="results-title">План закупок</h2><p>Полный набор: ${integer.format(draft.rows.length)} позиций. Проверяйте исходные числа перед утверждением.</p></div><span class="results-count">Реальные Excel · локальный расчёт</span></div>
    <div class="metrics"><div class="metric featured"><div class="metric-label">К заказу</div><div class="metric-value">${integer.format(total.ordered)} <small>позиций</small></div><p class="metric-caption">Количество больше нуля</p></div><div class="metric critical"><div class="metric-label">Нужно решение</div><div class="metric-value">${integer.format(total.blocked)} <small>позиций</small></div><p class="metric-caption">Нет расчёта или не хватает данных</p></div><div class="metric"><div class="metric-label">Срочные</div><div class="metric-value">${integer.format(total.critical)} <small>позиций</small></div><p class="metric-caption">Риск дефицита в горизонте</p></div><div class="metric"><div class="metric-label">Исключены менеджером</div><div class="metric-value">${integer.format(total.excluded)} <small>позиций</small></div><p class="metric-caption">Сохранятся в CSV со статусом</p></div></div>
    ${warnings.length ? `<details id="calculation-warnings" class="warnings" ${warningsOpen ? 'open' : ''}><summary><strong>Все замечания расчёта (${integer.format(warnings.length)})</strong></summary><p>Замечания также доступны в объяснении каждого товара. Все записи доступны на страницах.</p><div class="pagination"><button type="button" class="button button-secondary" data-warning-page="${resultWarningsPage - 1}" ${resultWarningsPage === 1 ? 'disabled' : ''}>Назад</button><span>${warningStart + 1}–${Math.min(warningStart + PAGE_SIZE, warnings.length)} из ${integer.format(warnings.length)} · страница ${resultWarningsPage} / ${warningPages}</span><button type="button" class="button button-secondary" data-warning-page="${resultWarningsPage + 1}" ${resultWarningsPage === warningPages ? 'disabled' : ''}>Далее</button></div><ul>${warnings.slice(warningStart, warningStart + PAGE_SIZE).map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></details>` : ''}
    <div class="result-controls"><div class="field"><label for="result-search">Поиск по всем товарам</label><input id="result-search" type="search" value="${escapeHtml(resultSearch)}" placeholder="Название, код 1С или артикул" /></div><div class="field"><label for="result-status">Строки на экране</label><select id="result-status"><option value="all" ${resultStatus === 'all' ? 'selected' : ''}>Все</option><option value="ready" ${resultStatus === 'ready' ? 'selected' : ''}>С количеством к проверке</option><option value="blocked" ${resultStatus === 'blocked' ? 'selected' : ''}>Без расчёта / требуют решения</option><option value="excluded" ${resultStatus === 'excluded' ? 'selected' : ''}>Исключённые из заказа</option></select></div><button id="exclude-blocked-button" type="button" class="button button-secondary" ${total.blocked ? '' : 'disabled'}>Исключить строки без расчёта из заказа (${integer.format(total.blocked)})</button></div>
    <p class="results-note">Поиск и страницы меняют только отображение. Утверждение и CSV охватывают все ${integer.format(draft.rows.length)} строк расчёта. Исключение — явное решение менеджера; неизвестное количество не заменяется нулём.</p>${pagination}
    ${groups.size ? [...groups.values()].map(group => `<section class="supplier" aria-label="Поставщик ${escapeHtml(group.name)}"><div class="supplier-heading"><div class="supplier-identity"><span class="supplier-symbol" aria-hidden="true">▤</span><div><h3>${escapeHtml(group.name)}</h3><p>${integer.format(group.rows.length)} позиций на этой странице</p></div></div></div><div class="table-scroll"><table><caption class="sr-only">Рекомендации: ${escapeHtml(group.name)}</caption><thead><tr><th scope="col">Товар / склад</th><th scope="col">Базовый спрос</th><th scope="col">Остаток и в пути</th><th scope="col">Заказать</th><th scope="col">Приоритет</th></tr></thead><tbody>${group.rows.map(({ row, index }) => realRowMarkup(row, index)).join('')}</tbody></table></div></section>`).join('') : '<div class="no-recommendations"><h3>Нет строк по выбранному поиску</h3><p>Измените поиск или состояние строк. Остальные позиции сохранены в плане.</p></div>'}${pagination}<p class="warning-footnote">Месячные остатки не подтверждают точные дни дефицита. Номера документов не считаются ID клиентов. Автоматической отправки заказов нет; CSV — универсальный формат, без заявления совместимости с 1С.</p>`;
  $('#results').hidden = false;
  $('#empty-results').hidden = true;
  renderReviewBar();
  renderAnalystPanel();
  setStep(draft.status === 'approved' ? 3 : 2);
}

function renderReviewBar() {
  if (!draft) return;
  const total = totals();
  const approved = draft.status === 'approved' && invalidQuantities.size === 0;
  const canApprove = invalidQuantities.size === 0 && draft.rows.length > 0 && total.blocked === 0;
  $('#review-bar').innerHTML = `<div class="review-status ${approved ? 'approved' : ''}"><span class="review-status-icon" aria-hidden="true">${approved ? '✓' : '✎'}</span><div><strong>${approved ? 'План утверждён и готов к экспорту' : invalidQuantities.size ? 'Исправьте количество в отмеченных строках' : 'Проверьте план перед утверждением'}</strong><p>${integer.format(total.ordered)} позиций · ${integer.format(total.suppliers)} поставщиков${total.changed ? ` · Изменено вручную: ${integer.format(total.changed)}` : ''}${total.ordered === 0 ? ' · Нет позиций с количеством больше нуля' : ''}</p></div></div><div class="review-actions"><button id="approve-button" class="button ${approved ? 'button-secondary' : 'button-lime'}" type="button" ${!canApprove || approved ? 'disabled' : ''}>${approved ? '✓ План утверждён' : 'Утвердить план'}</button><button id="export-button" class="button button-primary" type="button" ${!approved ? 'disabled' : ''}><span aria-hidden="true">↓</span> Скачать CSV</button></div>`;
  $('#review-bar').hidden = false;
  if (isReal() && !approved) {
    $('#review-bar .review-status strong').textContent = invalidQuantities.size ? 'Исправьте количество в отмеченных строках' : total.blocked ? `Требуется решение по ${integer.format(total.blocked)} строкам` : 'Полный план готов к утверждению';
    $('#review-bar .review-status p').textContent += ` · Исключено: ${integer.format(total.excluded)} · Всего в плане: ${integer.format(draft.rows.length)}`;
  }
  if (isReal()) {
    const metrics = [...$('#results').querySelectorAll('.metric-value')];
    [total.ordered, total.blocked, total.critical, total.excluded].forEach((value, index) => {
      if (metrics[index]) metrics[index].innerHTML = `${integer.format(value)} <small>позиций</small>`;
    });
    const exclusion = $('#exclude-blocked-button');
    if (exclusion) { exclusion.disabled = total.blocked === 0; exclusion.textContent = `Исключить строки без расчёта из заказа (${integer.format(total.blocked)})`; }
  }
}

$('#demo-button').addEventListener('click', () => {
  uploadSequence += 1;
  try { loadDataset(createDemoData(), 'Демонстрационный набор'); }
  catch (error) { showNotice(`Не удалось загрузить демонстрационный набор: ${error.message}`, 'error'); }
});

$('#import-excel-button').addEventListener('click', async () => {
  const paths = { systeme: $('#systeme-path').value.trim(), iek: $('#iek-path').value.trim() };
  if (!paths.systeme && !paths.iek) { showNotice('Укажите хотя бы одну папку с исходными Excel-файлами.', 'error'); return; }
  const sequence = ++uploadSequence;
  const button = $('#import-excel-button');
  button.disabled = true;
  button.textContent = 'Читаем все Excel-файлы…';
  $('#calculate-button').disabled = true;
  showNotice('Локальный сервер читает листы и сопоставляет полный объём данных. Это может занять несколько секунд. Исходные файлы не изменяются.');
  try {
    const response = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || payload.message || `Ошибка локального импорта (${response.status}).`);
    if (sequence !== uploadSequence) return;
    loadDataset(payload.dataset || payload, 'Excel SystemElectric и ИЭК', true);
    $('#import-report').open = true;
  } catch (error) {
    if (sequence === uploadSequence) showNotice(`Не удалось импортировать Excel: ${error.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Импортировать Excel двух поставщиков';
    $('#calculate-button').disabled = !dataset;
  }
});

$('#upload-button').addEventListener('click', () => $('#file-input').click());

$('#file-input').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const sequence = ++uploadSequence;
  invalidateResult();
  dataset = null;
  $('#settings-fields').disabled = true;
  $('#calculate-button').disabled = true;
  $('#dataset-info').hidden = true;
  $('#import-report').hidden = true;
  $('.data-panel').classList.remove('loaded');
  $('#asof-label').textContent = 'Загрузка и проверка файла…';
  setStep(0);
  showNotice('Проверяем структуру и значения загруженного файла…');
  try {
    if (file.size > 30 * 1024 * 1024) throw new Error('Размер файла превышает 30 МБ. Для MVP используйте меньшую выборку.');
    const contents = await file.text();
    if (sequence !== uploadSequence) return;
    let parsed;
    try { parsed = JSON.parse(contents.replace(/^\uFEFF/, '')); }
    catch { throw new Error('Некорректный JSON. Проверьте синтаксис файла или используйте скачанный пример.'); }
    loadDataset(parsed, file.name);
  } catch (error) {
    if (sequence !== uploadSequence) return;
    $('#asof-label').textContent = 'Файл не загружен';
    showNotice(`Не удалось загрузить файл: ${error.message}`, 'error');
  } finally {
    event.target.value = '';
  }
});

$('#download-demo').addEventListener('click', () => {
  try { download(JSON.stringify(createDemoData(), null, 2), 'elektrokomplekt-demo.json', 'application/json;charset=utf-8'); }
  catch (error) { showNotice(`Не удалось создать пример: ${error.message}`, 'error'); }
});

['#warehouse', '#category', '#growth-mode', '#growth-percent'].forEach((selector) => {
  $(selector).addEventListener(selector === '#growth-percent' ? 'input' : 'change', () => {
    $('#growth-percent').disabled = $('#growth-mode').value !== 'manual';
    invalidateResult('Параметры изменены. Запустите расчёт, чтобы получить новый план.');
  });
});

['supplier', 'lead-days', 'review-days', 'safety-days', 'lookback-months', 'seasonality-mode', 'sales-source', 'stock-mode', 'stock-snapshot-date', 'unknown-stock', 'monthly-blanks', 'fallback-pack', 'fallback-moq', 'eta-year', 'allow-stale-stock', 'confirm-detail-scope', 'include-partial-month', 'assumptions-confirmed'].forEach(id => {
  $(`#${id}`).addEventListener('change', () => invalidateResult('Параметры изменены. Запустите расчёт, чтобы получить новый план.'));
});

$('#calculation-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!dataset) { showNotice('Сначала загрузите данные или выберите демонстрационный набор.', 'error'); return; }
  const button = $('#calculate-button');
  button.disabled = true;
  button.textContent = 'Рассчитываем…';
  showNotice('');
  try {
      const options = selectedOptions();
      await new Promise(resolve => setTimeout(resolve, 0));
      const result = isReal() ? calculateRealRecommendations(dataset, options) : calculateRecommendations(dataset, options);
    if (aiAnalysis) markAnalysisStale('Расчёт плана пересоздан. Запустите анализ снова.');
    draft = createDraft(result, dataset, options);
    calculation = result;
    invalidQuantities.clear();
    invalidQuantityValues.clear();
    resultPage = 1;
    resultSearch = '';
    resultStatus = 'all';
    resultWarningsPage = 1;
    renderResults();
    showNotice(`Расчёт готов: ${integer.format(draft.rows.length)} позиций. Проверьте объяснения и количество перед утверждением.`, 'success');
    $('#results').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  } catch (error) {
    invalidateResult();
    showNotice(`Не удалось выполнить расчёт: ${error.message}`, 'error');
  } finally {
    button.disabled = false;
    button.innerHTML = 'Рассчитать потребность <span aria-hidden="true">↗</span>';
  }
});

$('#results').addEventListener('click', (event) => {
  const warningButton = event.target.closest('[data-warning-page]');
  if (warningButton) { resultWarningsPage = Number(warningButton.dataset.warningPage); renderResults(); return; }
  const pageButton = event.target.closest('[data-result-page]');
  if (pageButton) { resultPage = Number(pageButton.dataset.resultPage); renderResults(); return; }
  const factsButton = event.target.closest('[data-download-facts]');
  if (factsButton) {
    const row = draft?.rows.find(candidate => String(candidate.id) === factsButton.dataset.downloadFacts);
    if (row) download(JSON.stringify({ productId: row.productId, article: row.article, sourceFacts: row.sourceFacts, sources: row.sources, explanation: row.explanation }, null, 2), `istochniki-${String(row.productCode || row.productId).replace(/[^\p{L}\p{N}_-]/gu, '_')}.json`, 'application/json;charset=utf-8');
    return;
  }
  if (event.target.closest('#exclude-blocked-button')) {
    try {
      let count = 0;
      for (const row of draft.rows) if (!row.excluded && (row.quantity == null || (row.blockedReason && !row.manualDecision))) {
        setRowExcluded(draft, row.id, true);
        invalidQuantities.delete(String(row.id));
        invalidQuantityValues.delete(String(row.id));
        count++;
      }
      if (count) markAnalysisStale('Состав плана изменён. Запустите анализ снова.');
      renderResults();
      showNotice(`По вашему действию исключено ${integer.format(count)} строк без расчёта. Они сохранятся в CSV со статусом «Исключено».`, 'info');
    } catch (error) { showNotice(error.message, 'error'); }
    return;
  }
  const button = event.target.closest('[data-explain]');
  if (!button) return;
  const panel = document.getElementById(`${button.dataset.explain}-explanation`);
  const expanded = button.getAttribute('aria-expanded') === 'true';
  button.setAttribute('aria-expanded', String(!expanded));
  panel.hidden = expanded;
  if (!expanded && button.dataset.factsRow) {
    const row = draft.rows.find(candidate => String(candidate.id) === button.dataset.factsRow);
    if (row) renderSourceFacts(row, panel.querySelector('[data-facts-content]'));
  }
});

$('#results').addEventListener('change', event => {
  if (event.target.id === 'result-status') { resultStatus = event.target.value; resultPage = 1; renderResults(); return; }
  const exclude = event.target.closest('[data-excluded]');
  if (!exclude) return;
  try {
    const row = draft.rows.find(candidate => String(candidate.id) === exclude.dataset.excluded);
    if (!row) return;
    setRowExcluded(draft, row.id, exclude.checked);
    markAnalysisStale('Состав плана изменён. Запустите анализ снова.');
    invalidQuantities.delete(String(row.id));
    invalidQuantityValues.delete(String(row.id));
    renderResults();
  } catch (error) { showNotice(error.message, 'error'); }
});

$('#results').addEventListener('input', (event) => {
  if (event.target.id === 'result-search') {
    const start = event.target.selectionStart;
    const end = event.target.selectionEnd;
    resultSearch = event.target.value;
    resultPage = 1;
    renderResults();
    $('#result-search').focus();
    $('#result-search').setSelectionRange(start, end);
    return;
  }
  const input = event.target.closest('[data-quantity]');
  if (!input || !draft) return;
  const rowId = input.dataset.quantity;
  const row = draft.rows.find((candidate) => String(candidate.id) === rowId);
  if (!row) return;
  markAnalysisStale('Количество в плане изменено. Запустите анализ снова.');
  const errorElement = document.getElementById(input.id.replace('-quantity', '-error'));
  draft.status = 'draft';
  delete draft.approvedAt;
  setStep(2);
  try {
    if (!/^\d+$/.test(input.value)) throw new Error('Введите целое число от 0.');
    const value = Number(input.value);
    if (!Number.isSafeInteger(value)) throw new Error('Количество слишком велико.');
    if (value > 0 && row.unitConversionRequired) throw new Error('Проверьте единицы и кратность в источнике. Положительный заказ заблокирован; можно исключить строку или указать 0.');
    updateQuantity(draft, row.id, value);
    invalidQuantities.delete(rowId);
    invalidQuantityValues.delete(rowId);
    input.setAttribute('aria-invalid', 'false');
    input.classList.toggle('edited', value !== row.suggestedQuantity);
    errorElement.hidden = true;
    const status = input.closest('tr').querySelector('.manual-status');
    if (status) status.textContent = row.manualDecision ? 'Ручное решение менеджера' : '';
    if (isReal() && row.blockedReason) input.closest('tr').querySelector('.urgency').textContent = 'Ручное решение';
  } catch (error) {
    invalidQuantities.set(rowId, error.message);
    invalidQuantityValues.set(rowId, input.value);
    input.setAttribute('aria-invalid', 'true');
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  }
  renderReviewBar();
});

function updateAiAnswerState(message, type = '') {
  const status = $('#ai-result-state');
  status.textContent = message;
  status.className = `ai-result-state${type ? ` ${type}` : ''}`;
  status.hidden = false;
}

$('#ai-selected-item').addEventListener('change', () => markAnalysisStale('Выбранная позиция изменилась. Запустите анализ снова.'));
let aiPreviewTimer = null;
$('#ai-question').addEventListener('input', () => {
  $('#ai-consent').checked = false;
  markAnalysisStale('Вопрос изменён. Отправьте новый запрос для актуального ответа.', false);
  clearTimeout(aiPreviewTimer);
  aiPreviewTimer = setTimeout(() => updateAnalystPreview(false), 160);
});

$('#ai-analyze').addEventListener('click', async () => {
  if (aiInFlight || !draft || !aiConfigured) return;
  let payload;
  try { payload = buildAnalystPayload({ draft, selectedProductId: $('#ai-selected-item').value, question: $('#ai-question').value }); }
  catch (error) { updateAiAnswerState(error.message, 'error'); return; }
  if (!draft.isDemo && !$('#ai-consent').checked) {
    updateAiAnswerState('Для реальных данных сначала просмотрите точный состав запроса выше и поставьте явное согласие.', 'error');
    return;
  }
  aiInFlight = true;
  aiAbortController = new AbortController();
  const controller = aiAbortController;
  refreshAnalystAvailability();
  updateAiAnswerState('Отправляем только подготовленную сводку и ожидаем ответ OpenAI…');
  try {
    const response = await fetch('/api/ai/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal,
    });
    let result;
    try { result = await response.json(); }
    catch { throw new Error('Локальный сервер вернул непонятный ответ. Основной план сохранён.'); }
    if (!response.ok) throw new Error(result.error || 'AI-анализ не выполнен. Основной план сохранён.');
    if (controller.signal.aborted) return;
    aiAnalysis = { text: result.answer, stale: false, model: result.model || aiModel, asOf: draft.asOf };
    $('#ai-answer').textContent = result.answer;
    $('#ai-answer').hidden = false;
    updateAiAnswerState(`Анализ готов · ${aiAnalysis.model} · данные на ${formattedDate(aiAnalysis.asOf)}. Проверьте выводы по первичным источникам.`, 'success');
  } catch (error) {
    if (!controller.signal.aborted) updateAiAnswerState(error.message || 'AI-анализ временно недоступен. Расчётный план сохранён.', 'error');
  } finally {
    if (aiAbortController === controller) aiAbortController = null;
    aiInFlight = false;
    refreshAnalystAvailability();
  }
});

$('#review-bar').addEventListener('click', (event) => {
  if (!draft) return;
  if (event.target.closest('#approve-button')) {
    try {
      if (invalidQuantities.size) throw new Error('Исправьте количество в отмеченных строках.');
      approveDraft(draft);
      renderReviewBar();
      setStep(3);
      showNotice('План утверждён. Скачайте CSV для дальнейшей обработки. Любое изменение количества потребует повторного утверждения.', 'success');
    } catch (error) { showNotice(error.message, 'error'); }
  }
  if (event.target.closest('#export-button')) {
    try {
      if (invalidQuantities.size) throw new Error('Исправьте количество и повторно утвердите план.');
      const csv = exportDraftCsv(draft);
      download(csv, `plan-zakupok-${dataset.asOf}${draft.isDemo ? '-demo' : ''}.csv`, 'text/csv;charset=utf-8');
      showNotice('CSV подготовлен для скачивания. Заказы поставщикам не отправлялись.', 'success');
    } catch (error) { showNotice(`Экспорт недоступен: ${error.message}`, 'error'); }
  }
});

setStep(0);
fetch('/api/sources').then(response => response.ok ? response.json() : null).then(info => {
  if (!info?.paths) return;
  if (!$('#systeme-path').value) $('#systeme-path').value = info.paths.systeme || '';
  if (!$('#iek-path').value) $('#iek-path').value = info.paths.iek || '';
}).catch(() => { /* Demo and JSON remain usable even when the local import API is unavailable. */ });

fetch('/api/ai/status').then(async response => {
  if (!response.ok) throw new Error('Сервер проверки AI недоступен.');
  return response.json();
}).then(status => {
  aiConfigured = status.configured === true;
  if (typeof status.model === 'string') aiModel = status.model;
  refreshAnalystAvailability();
}).catch(() => {
  aiConfigured = false;
  $('#ai-config-state').textContent = 'Не удалось проверить AI-сервис. Основной расчёт и экспорт доступны.';
  refreshAnalystAvailability();
});
