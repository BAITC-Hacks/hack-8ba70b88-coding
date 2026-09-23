import { createDemoData } from './demo.js';
import { validateDataset } from './validation.js';
import { calculateRecommendations } from './engine.js';
import { createDraft, updateQuantity, approveDraft, exportDraftCsv } from './workflow.js';

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
  draft = null;
  calculation = null;
  invalidQuantities.clear();
  $('#results').hidden = true;
  $('#results').replaceChildren();
  $('#empty-results').hidden = false;
  $('#review-bar').hidden = true;
  setStep(dataset ? 1 : 0);
  if (message) showNotice(message);
}

function fillSelect(selector, items, allLabel) {
  const select = $(selector);
  select.replaceChildren(new Option(allLabel, 'all'));
  items.forEach((item) => select.add(new Option(item.name, item.id)));
}

function loadDataset(candidate, sourceName) {
  const validated = validateDataset(candidate);
  dataset = validated;
  invalidateResult();
  fillSelect('#warehouse', dataset.warehouses, 'Все склады');
  fillSelect('#category', dataset.categories, 'Все категории');
  $('#settings-fields').disabled = false;
  $('#growth-percent').disabled = $('#growth-mode').value !== 'manual';
  $('#calculate-button').disabled = false;
  $('#asof-label').textContent = `Расчёт на ${formattedDate(dataset.asOf)}`;
  const name = dataset.name || dataset.metadata?.name || sourceName || 'Пользовательский набор';
  const isDemo = dataset.isDemo === true;
  $('#dataset-info').innerHTML = `<div><div class="dataset-title">${escapeHtml(name)} <span class="badge ${isDemo ? 'badge-demo' : ''}">${isDemo ? 'ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ' : 'ЛОКАЛЬНЫЙ ФАЙЛ'}</span></div><p class="dataset-description">${integer.format(dataset.products.length)} товаров · ${integer.format(dataset.warehouses.length)} складов · История с ${escapeHtml(formattedDate(dataset.historyStart))}${isDemo ? ' · Воспроизводимый синтетический набор, не данные компании' : ''}</p></div><span class="dataset-check" aria-label="Данные проверены">✓</span>`;
  $('#dataset-info').hidden = false;
  $('.data-panel').classList.add('loaded');
  $('#demo-button').innerHTML = '<span aria-hidden="true">✦</span> Загрузить демо';
  $('#upload-button').innerHTML = '<span aria-hidden="true">↑</span> Другой JSON-файл';
  showNotice(isDemo ? 'Демонстрационный набор готов. В нём есть сезонность, рост, дефицит, разовые крупные продажи и регулярные закупки крупных клиентов.' : 'Файл проверен и загружен. Выберите параметры и запустите расчёт.', 'success');
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

function selectedOptions() {
  const annualGrowthPct = Number($('#growth-percent').value);
  if ($('#growth-mode').value === 'manual' && ($('#growth-percent').value.trim() === '' || !Number.isFinite(annualGrowthPct) || annualGrowthPct < -90 || annualGrowthPct > 200)) {
    throw new Error('Укажите годовой прирост от −90 до 200 %.');
  }
  return { warehouseId: $('#warehouse').value, categoryId: $('#category').value, growthMode: $('#growth-mode').value, annualGrowthPct };
}

function totals() {
  const rows = draft?.rows || [];
  return {
    ordered: rows.filter((row) => row.quantity > 0).length,
    suppliers: new Set(rows.filter((row) => row.quantity > 0).map((row) => row.supplierId)).size,
    changed: rows.filter((row) => row.quantity !== row.suggestedQuantity).length,
    critical: rows.filter((row) => row.urgency === 'critical').length,
    lostRows: rows.filter((row) => row.lostDemand > 0).length,
    outlierCount: rows.reduce((sum, row) => sum + (row.outlierCount || 0), 0),
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

function renderResults() {
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
  setStep(2);
}

function renderReviewBar() {
  if (!draft) return;
  const total = totals();
  const approved = draft.status === 'approved' && invalidQuantities.size === 0;
  const canApprove = invalidQuantities.size === 0 && draft.rows.length > 0;
  $('#review-bar').innerHTML = `<div class="review-status ${approved ? 'approved' : ''}"><span class="review-status-icon" aria-hidden="true">${approved ? '✓' : '✎'}</span><div><strong>${approved ? 'План утверждён и готов к экспорту' : invalidQuantities.size ? 'Исправьте количество в отмеченных строках' : 'Проверьте план перед утверждением'}</strong><p>${integer.format(total.ordered)} позиций · ${integer.format(total.suppliers)} поставщиков${total.changed ? ` · Изменено вручную: ${integer.format(total.changed)}` : ''}${total.ordered === 0 ? ' · Нет позиций с количеством больше нуля' : ''}</p></div></div><div class="review-actions"><button id="approve-button" class="button ${approved ? 'button-secondary' : 'button-lime'}" type="button" ${!canApprove || approved ? 'disabled' : ''}>${approved ? '✓ План утверждён' : 'Утвердить план'}</button><button id="export-button" class="button button-primary" type="button" ${!approved ? 'disabled' : ''}><span aria-hidden="true">↓</span> Скачать CSV</button></div>`;
  $('#review-bar').hidden = false;
}

$('#demo-button').addEventListener('click', () => {
  uploadSequence += 1;
  try { loadDataset(createDemoData(), 'Демонстрационный набор'); }
  catch (error) { showNotice(`Не удалось загрузить демонстрационный набор: ${error.message}`, 'error'); }
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

$('#calculation-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!dataset) { showNotice('Сначала загрузите данные или выберите демонстрационный набор.', 'error'); return; }
  const button = $('#calculate-button');
  button.disabled = true;
  button.textContent = 'Рассчитываем…';
  showNotice('');
  try {
    const options = selectedOptions();
    const result = calculateRecommendations(dataset, options);
    draft = createDraft(result, dataset, options);
    calculation = result;
    invalidQuantities.clear();
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
  const button = event.target.closest('[data-explain]');
  if (!button) return;
  const panel = document.getElementById(`${button.dataset.explain}-explanation`);
  const expanded = button.getAttribute('aria-expanded') === 'true';
  button.setAttribute('aria-expanded', String(!expanded));
  panel.hidden = expanded;
});

$('#results').addEventListener('input', (event) => {
  const input = event.target.closest('[data-quantity]');
  if (!input || !draft) return;
  const rowId = input.dataset.quantity;
  const row = draft.rows.find((candidate) => String(candidate.id) === rowId);
  if (!row) return;
  const errorElement = document.getElementById(input.id.replace('-quantity', '-error'));
  draft.status = 'draft';
  delete draft.approvedAt;
  setStep(2);
  try {
    if (!/^\d+$/.test(input.value)) throw new Error('Введите целое число от 0.');
    const value = Number(input.value);
    if (!Number.isSafeInteger(value)) throw new Error('Количество слишком велико.');
    updateQuantity(draft, row.id, value);
    invalidQuantities.delete(rowId);
    input.setAttribute('aria-invalid', 'false');
    input.classList.toggle('edited', value !== row.suggestedQuantity);
    errorElement.hidden = true;
  } catch (error) {
    invalidQuantities.set(rowId, error.message);
    input.setAttribute('aria-invalid', 'true');
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  }
  renderReviewBar();
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
