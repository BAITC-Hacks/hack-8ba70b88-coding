// Supplier profiles describe the inspected exports, not a generic 1C exchange format.
// The importer is pure: it consumes parsed workbooks and never reads or writes a file.
const SUPPLIERS = { systeme: 'SystemElectric', iek: 'ИЭК' };
const TYPES = ['moq', 'detail', 'stocks', 'monthly', 'seasonality', 'inbound'];
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const clean = value => value == null ? '' : String(value).replace(/\u00a0/g, ' ').trim();
const key = value => clean(value).toLocaleUpperCase('ru');
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const identity = value => { const text = clean(value); return text && text !== '0' && !text.startsWith('#') ? text : null; };
const plusDay = date => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const issueText = {
  customer: 'В источниках нет ID клиента. Номер документа не считается клиентом; автоматическое исключение разовых клиентских заказов недоступно.',
  stock: 'Месячные остатки не определяют дни отсутствия товара. Пустая ячейка не подтверждает нулевой остаток.',
  scope: 'Месячные продажи и остатки не содержат складского разреза. Подробные продажи по складам не приравнены к общему объёму.',
  lead: 'Срок нового заказа отсутствует: он задаётся менеджером, а не выводится из даты существующей поставки.',
  season: 'Единица агрегата в файле сезонности не указана. Индексы поставщика — явно выбранное приближение для товаров; незавершённые годы не используются как полные.',
};

function month(value) {
  const text = clean(value).toLowerCase();
  const year = /\b(20\d{2})\b/.exec(text)?.[1];
  const index = MONTHS.findIndex(prefix => text.startsWith(prefix));
  return year && index >= 0 ? `${year}-${String(index + 1).padStart(2, '0')}` : null;
}
function dateValue(value, date1904 = false) {
  if (typeof value === 'number' && value >= 1 && value < 100000) {
    return new Date(Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30) + Math.floor(value) * 86400000).toISOString().slice(0, 10);
  }
  const text = clean(value);
  const match = /\b(\d{2})\.(\d{2})\.(20\d{2})\b/.exec(text);
  const iso = match ? `${match[3]}-${match[2]}-${match[1]}` : /^(20\d{2}-\d{2}-\d{2})(?:T|\s|$)/.exec(text)?.[1];
  if (!iso) return null;
  const parsed = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === iso ? iso : null;
}
const colNumber = column => [...column].reduce((sum, c) => sum * 26 + c.charCodeAt(0) - 64, 0);
const cellEntries = row => Object.entries(row.cells || {}).sort((a, b) => colNumber(a[0]) - colNumber(b[0]));
const sourceFor = (entry, sheet, row, col = 'A') => `${entry.filename} / ${sheet.name}!${col}${row.number}`;

export function classifySupplierWorkbook(filename) {
  const name = clean(filename).toLowerCase();
  if (/moq|минимальн|кратност/.test(name)) return 'moq';
  if (/динамик/.test(name)) return 'detail';
  if (/сезонност/.test(name)) return 'seasonality';
  if (/путь|пути/.test(name)) return 'inbound';
  if (/остатк/.test(name)) return 'stocks';
  if (/продаж/.test(name)) return 'monthly';
  return null;
}

function sheetProfile(type, supplierId, sheet) {
  const earlyRows = sheet.rows.filter(row => row.number <= 12);
  if (type === 'seasonality') {
    const header = earlyRows.find(row => key(row.cells.A) === 'ГОД' && key(row.cells.B).startsWith('ЯНВ'));
    return header ? { header, type } : null;
  }
  if (type === 'detail') {
    const header = earlyRows.find(row => key(row.cells.A) === 'ДАТА' && key(row.cells.D) === 'КОД' && key(row.cells.H) === 'КОЛИЧЕСТВО');
    return header ? { header, type, code: 'D', name: 'E', unit: 'F' } : null;
  }
  if (type === 'moq') {
    const header = earlyRows.find(row => supplierId === 'systeme'
      ? key(row.cells.E).includes('КРАТНОСТ') && key(row.cells.C).includes('КОД')
      : key(row.cells.E).startsWith('МИН.') && key(row.cells.B).includes('КОД'));
    return header ? { header, type, code: supplierId === 'systeme' ? 'C' : 'B', article: supplierId === 'systeme' ? 'D' : 'C', name: supplierId === 'systeme' ? 'B' : 'D' } : null;
  }
  if (type === 'inbound') {
    const header = earlyRows.find(row => supplierId === 'systeme'
      ? key(row.cells.C).includes('КОД') && key(row.cells.AZ) === 'СВОБОДНЫЙ ОСТАТОК'
      : key(row.cells.A).includes('КОД') && key(row.cells.B).includes('АРТИКУЛ'));
    if (!header) return null;
    const result = { header, type, code: supplierId === 'systeme' ? 'C' : 'A', article: 'B', name: supplierId === 'systeme' ? 'D' : 'C' };
    result.lots = cellEntries(header).filter(([col, value]) => supplierId === 'systeme' ? /в пути/i.test(clean(value)) : colNumber(col) > 3 && /поступление/i.test(clean(value)));
    return result;
  }
  const header = earlyRows.find(row => cellEntries(row).some(([, value]) => key(value).includes('НОМЕНКЛАТУРА.КОД')) && cellEntries(row).some(([, value]) => month(value)));
  if (!header) return null;
  const columns = cellEntries(header);
  return {
    header, type,
    code: columns.find(([, value]) => key(value).includes('НОМЕНКЛАТУРА.КОД'))[0],
    name: columns.find(([, value]) => key(value) === 'НОМЕНКЛАТУРА')?.[0],
    unit: columns.find(([, value]) => /^(ЕД\.|ЕД )/.test(key(value)))?.[0],
    article: columns.find(([, value]) => key(value) === 'АРТИКУЛ')?.[0],
    months: columns.filter(([, value]) => month(value)).map(([col, value]) => ({ col, month: month(value) })),
    opening: earlyRows.some(row => Object.values(row.cells).some(value => /нач\.?\s*остаток/i.test(clean(value)))),
  };
}

/** Import both full supplier sets. Empty cells remain unknown; separate sources never add demand twice. */
export function importSupplierWorkbooks(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('Выберите Excel-файлы поставщиков.');
  const report = { files: [], suppliers: [], issues: [], reconciliation: [], skippedRows: 0, duplicateRows: 0, missingCells: {}, corrections: [], excludedDocuments: [], unmatched: [], assumptionsRequired: Object.values(issueText) };
  const products = new Map();
  const codeMap = new Map();
  const articleMap = new Map();
  const categories = new Map();
  const warehouses = new Map([['global', { id: 'global', name: 'Совокупно — без распределения' }]]);
  const suppliers = new Map();
  const prepared = [];
  const seenFiles = new Set();
  const addIssue = (type, message, source, product, severity = 'warning') => {
    report.issues.push({ type, severity, ...(product ? { productId: product.id } : {}), source, message });
  };
  const missing = type => { report.missingCells[type] = (report.missingCells[type] || 0) + 1; };
  for (const raw of entries) {
    if (!SUPPLIERS[raw.supplierId]) throw new Error('Неизвестный поставщик. Выберите SystemElectric или ИЭК.');
    if (!raw.workbook?.sheets?.length) throw new Error(`Нет листов в ${raw.filename}.`);
    const filename = clean(raw.filename).split(/[\\/]/).at(-1);
    const type = classifySupplierWorkbook(filename);
    if (!type) throw new Error(`Не распознан тип файла ${filename}. Нужны шесть проверенных типов источников.`);
    const fileKey = `${raw.supplierId}:${type}`;
    if (seenFiles.has(fileKey)) throw new Error(`Повторный источник ${type} для ${SUPPLIERS[raw.supplierId]}. Выберите один файл каждого типа.`);
    seenFiles.add(fileKey);
    if (!suppliers.has(raw.supplierId)) suppliers.set(raw.supplierId, { id: raw.supplierId, name: SUPPLIERS[raw.supplierId], seasonalityYears: [], detailPeriod: { start: null, end: null }, warnings: Object.values(issueText) });
    const entry = { ...raw, filename, type };
    const file = { supplierId: entry.supplierId, name: filename, type, sheets: [], products: 0, rowCount: 0, periodStart: null, periodEnd: null };
    const activeSheets = [];
    for (const sheet of entry.workbook.sheets) {
      const profile = sheetProfile(type, entry.supplierId, sheet);
      const sheetInfo = { name: sheet.name, rows: sheet.rows.length, headers: profile ? profile.header.cells : (sheet.rows.find(row => row.number <= 5 && Object.keys(row.cells).length > 3)?.cells || {}), status: profile ? 'used' : 'not-used:duplicated aggregate' };
      file.sheets.push(sheetInfo);
      if (profile) activeSheets.push({ sheet, profile });
    }
    if (activeSheets.length !== 1) throw new Error(`${filename}: ожидается один основной лист с проверенными заголовками, найдено ${activeSheets.length}.`);
    for (const warning of entry.workbook.warnings || []) addIssue('workbook', typeof warning === 'string' ? warning : JSON.stringify(warning), filename);
    const item = { entry, file, ...activeSheets[0], fileProducts: new Set(), inboundRows: new Set() };
    prepared.push(item);
    report.files.push(file);
  }
  for (const supplier of suppliers.values()) {
    const absent = TYPES.filter(type => !seenFiles.has(`${supplier.id}:${type}`));
    if (absent.length) throw new Error(`${supplier.name}: не хватает источников: ${absent.join(', ')}. Загрузите все шесть файлов.`);
  }
  function productNew(supplierId, code, article, name) {
    const id = `${supplierId}:${code || `article:${key(article)}`}`;
    const categoryId = `${supplierId}:unclassified`;
    if (!categories.has(categoryId)) categories.set(categoryId, { id: categoryId, name: `${SUPPLIERS[supplierId]} — без категории` });
    const product = { id, supplierId, code, article, name, unit: null, categoryId, packSize: null, moq: null, packSource: null, moqSource: null, monthlySales: [], detailMonthly: [], stocks: [], inbound: [], warnings: [] };
    Object.defineProperty(product, '_state', { value: { monthly: new Map(), stocks: new Map(), detail: new Map(), types: new Set(), constraints: new Map(), articles: new Set() } });
    products.set(id, product);
    if (code) codeMap.set(`${supplierId}:${key(code)}`, product);
    return product;
  }
  // Pass 1 creates authoritative supplier + code identities before article-only rows are resolved.
  for (const item of prepared.filter(item => item.entry.type !== 'seasonality')) {
    const { entry, sheet, profile } = item;
    for (const row of sheet.rows) {
      if (row.number <= profile.header.number) continue;
      const name = clean(row.cells[profile.name]);
      const code = identity(row.cells[profile.code]);
      if (!code || !name || key(name) === 'ИТОГО') continue;
      const article = identity(row.cells[profile.article]);
      const codeKey = `${entry.supplierId}:${key(code)}`;
      const product = codeMap.get(codeKey) || productNew(entry.supplierId, code, article, name);
      if (article) {
        const articleKey = `${entry.supplierId}:${key(article)}`;
        if (!articleMap.has(articleKey)) articleMap.set(articleKey, new Set());
        articleMap.get(articleKey).add(product.id);
        product._state.articles.add(article);
        if (!product.article) product.article = article;
      }
      const unit = clean(row.cells[profile.unit]);
      if (unit && !product.unit) product.unit = unit;
    }
  }
  for (const [articleKey, ids] of articleMap) {
    if (ids.size > 1) addIssue('article-conflict', `Артикул соответствует ${ids.size} разным кодам 1С; товары не объединены.`, articleKey);
  }
  for (const product of products.values()) {
    if (product._state.articles.size > 1) {
      product.warnings.push('У одного кода 1С найдены разные артикулы. Проверьте сопоставление.');
      addIssue('code-article-conflict', product.warnings.at(-1), product.id, product);
    }
  }
  function resolve(item, row) {
    const { entry, sheet, profile } = item;
    const code = identity(row.cells[profile.code]);
    const article = identity(row.cells[profile.article]);
    const name = clean(row.cells[profile.name]);
    if (!name || key(name) === 'ИТОГО') { report.skippedRows++; return null; }
    let product = code ? codeMap.get(`${entry.supplierId}:${key(code)}`) : null;
    if (!code && article) {
      const ids = articleMap.get(`${entry.supplierId}:${key(article)}`);
      if (ids?.size === 1) product = products.get([...ids][0]);
      else if (ids?.size > 1) { addIssue('ambiguous-article', 'Нет кода 1С, а артикул неоднозначен. Строка не присоединена.', sourceFor(entry, sheet, row), null); report.skippedRows++; return null; }
      else product = products.get(`${entry.supplierId}:article:${key(article)}`) || productNew(entry.supplierId, null, article, name);
    }
    if (!product) { addIssue('missing-identity', 'Строка товара без пригодного кода 1С и артикула не присоединена.', sourceFor(entry, sheet, row)); report.skippedRows++; return null; }
    product._state.types.add(entry.type);
    item.fileProducts.add(product.id);
    item.file.rowCount++;
    return product;
  }
  function valueAt(item, row, column, kind, product, allowNegative = true) {
    const value = row.cells[column];
    if (value == null || clean(value) === '') { missing(kind); return null; }
    const quantity = numeric(value);
    if (quantity == null || (!allowNegative && quantity < 0)) {
      addIssue('invalid-number', `Некорректное числовое значение (${kind}); оставлено неизвестным.`, sourceFor(item.entry, item.sheet, row, column), product);
      return null;
    }
    return quantity;
  }
  function uniqueRecord(item, row, product, map, identityKey, record, list, kind) {
    const existing = map.get(identityKey);
    if (!existing) { map.set(identityKey, record); list.push(record); return; }
    if (existing.quantity === record.quantity) { report.duplicateRows++; return; }
    existing.quantity = null;
    existing.conflict = true;
    addIssue('duplicate-conflict', `Противоречивые дубли ${kind}; количество неизвестно, суммы не объединены.`, sourceFor(item.entry, item.sheet, row), product);
  }
  const earliest = (a, b) => !a || b < a ? b : a;
  const latest = (a, b) => !a || b > a ? b : a;
  for (const item of prepared) {
    const { entry, sheet, profile, file } = item;
    const supplier = suppliers.get(entry.supplierId);
    if (entry.type === 'seasonality') {
      for (const row of sheet.rows) {
        if (row.number <= profile.header.number || !Number.isInteger(row.cells.A) || row.cells.A < 2000 || row.cells.A > 2100) continue;
        const values = Array.from({ length: 12 }, (_, i) => valueAt(item, row, String.fromCharCode(66 + i), 'seasonality', null, false));
        supplier.seasonalityYears.push({ year: row.cells.A, values, source: sourceFor(entry, sheet, row, 'B') });
        file.rowCount++;
        for (let m = 0; m < 12; m++) if (values[m] != null) {
          const period = `${row.cells.A}-${String(m + 1).padStart(2, '0')}`;
          file.periodStart = earliest(file.periodStart, period);
          file.periodEnd = latest(file.periodEnd, period);
        }
      }
      if (!supplier.seasonalityYears.length) throw new Error(`${entry.filename}: не найдены исходные годовые ряды сезонности.`);
      continue;
    }
    for (const row of sheet.rows) {
      if (row.number <= profile.header.number) continue;
      const product = resolve(item, row);
      if (!product) continue;
      if (entry.type === 'moq') {
        const constraint = entry.supplierId === 'systeme' ? 'packSize' : 'moq';
        const sourceName = entry.supplierId === 'systeme' ? 'packSource' : 'moqSource';
        const quantity = valueAt(item, row, 'E', constraint, product, false);
        const valid = quantity != null && quantity > 0 ? quantity : null;
        if (quantity === 0) addIssue('invalid-constraint', 'Нулевая партия или кратность не является допустимым ограничением.', sourceFor(entry, sheet, row, 'E'), product);
        const prior = product._state.constraints.get(constraint);
        if (prior && prior.quantity !== valid) {
          product[constraint] = null;
          prior.conflict = true;
          addIssue('constraint-conflict', 'Разные ограничения одного товара: значение требует проверки.', sourceFor(entry, sheet, row, 'E'), product);
        } else if (!prior) {
          product[constraint] = valid;
          product[sourceName] = sourceFor(entry, sheet, row, 'E');
          product._state.constraints.set(constraint, { quantity: valid });
        } else report.duplicateRows++;
      } else if (entry.type === 'stocks' || entry.type === 'monthly') {
        for (const period of profile.months) {
          const quantity = valueAt(item, row, period.col, entry.type, product);
          const source = sourceFor(entry, sheet, row, period.col);
          if (entry.type === 'monthly') uniqueRecord(item, row, product, product._state.monthly, period.month, { month: period.month, quantity, source }, product.monthlySales, 'месячных продаж');
          else {
            uniqueRecord(item, row, product, product._state.stocks, period.month, { date: profile.opening ? `${period.month}-01` : null, month: period.month, quantity, basis: profile.opening ? 'opening' : 'unknown-monthly', reserve: null, source }, product.stocks, 'месячных остатков');
            if (quantity < 0) addIssue('negative-stock', 'Отрицательный остаток сохранён для проверки; это не отрицательное доступное количество.', source, product);
          }
          file.periodStart = earliest(file.periodStart, period.month);
          file.periodEnd = latest(file.periodEnd, period.month);
        }
        if (entry.type === 'monthly' && entry.supplierId === 'systeme' && row.cells.D != null) {
          const duplicatePack = numeric(row.cells.D);
          if (duplicatePack == null || duplicatePack <= 0 || (product.packSize != null && duplicatePack !== product.packSize)) addIssue('secondary-pack', 'Кратность из месячных продаж не используется: основной источник — отдельный файл MOQ/кратности.', sourceFor(entry, sheet, row, 'D'), product, 'info');
        }
      } else if (entry.type === 'detail') {
        const date = dateValue(row.cells.A, entry.workbook.date1904);
        if (!date) { addIssue('invalid-date', 'Дата движения не распознана; строка не включена в продажи.', sourceFor(entry, sheet, row, 'A'), product); continue; }
        file.periodStart = earliest(file.periodStart, date);
        file.periodEnd = latest(file.periodEnd, date);
        const quantity = valueAt(item, row, 'H', 'detail', product);
        if (quantity == null) continue;
        const document = clean(row.cells.C);
        if (!/^Расходная накладная(?:\s|$)/i.test(document)) {
          const documentType = /^Приходная накладная(?:\s|$)/i.test(document) ? 'Приходная накладная' : /^Заказ покупателя(?:\s|$)/i.test(document) ? 'Заказ покупателя' : 'Другой документ';
          report.excludedDocuments.push({ productId: product.id, date, quantity, documentType, source: sourceFor(entry, sheet, row, 'H') });
          addIssue('non-sale-document', `${documentType}: движение учтено в отчёте отдельно, не считается реализованным спросом.`, sourceFor(entry, sheet, row, 'C'), product, 'info');
          continue;
        }
        supplier.detailPeriod.end = latest(supplier.detailPeriod.end, date);
        if (quantity > 0) supplier.detailPeriod.start = earliest(supplier.detailPeriod.start, date);
        const warehouseName = clean(row.cells.G);
        const warehouseId = warehouseName ? `warehouse:${warehouseName}` : 'warehouse:unknown';
        if (!warehouses.has(warehouseId)) warehouses.set(warehouseId, { id: warehouseId, name: warehouseName || 'Склад не указан' });
        if (!warehouseName) addIssue('missing-warehouse', 'У движения не указан склад; оно не распределено по другим складам.', sourceFor(entry, sheet, row, 'G'), product);
        const period = date.slice(0, 7);
        const detailKey = `${period}:${warehouseId}`;
        let aggregate = product._state.detail.get(detailKey);
        if (!aggregate) {
          aggregate = { month: period, warehouseId, positive: 0, negative: 0, returns: 0, corrections: 0, rows: 0, source: sourceFor(entry, sheet, row, 'H'), firstSourceRow: row.number, lastSourceRow: row.number, maxLineQuantity: 0, maxLineSource: null };
          product._state.detail.set(detailKey, aggregate);
          product.detailMonthly.push(aggregate);
        }
        aggregate.rows++;
        aggregate.lastSourceRow = row.number;
        aggregate.source = `${entry.filename} / ${sheet.name}!H${aggregate.firstSourceRow}:H${aggregate.lastSourceRow}; фильтр: код ${product.code || product.article}, месяц ${period}, склад ${warehouseName || 'не указан'}`;
        if (quantity < 0) { aggregate.negative += quantity; aggregate.corrections -= quantity; }
        else aggregate.positive += quantity;
        if (quantity > aggregate.maxLineQuantity) { aggregate.maxLineQuantity = quantity; aggregate.maxLineSource = sourceFor(entry, sheet, row, 'H'); }
      } else if (entry.type === 'inbound') {
        if (/закупаются\s+бухтами.*(?:метраж|метр)/i.test(clean(row.cells[profile.name]))) {
          product.unitConversionRequired = true;
          product.unitConversionSource = sourceFor(entry, sheet, row, profile.name);
          const message = 'Источник указывает закупку бухтами и учёт метрами. Коэффициент перевода не задан; перед заказом требуется проверить единицу, MOQ и кратность.';
          if (!product.warnings.includes(message)) product.warnings.push(message);
          addIssue('unit-conversion', message, product.unitConversionSource, product);
        }
        const fingerprint = JSON.stringify([product.id, identity(row.cells[profile.article]), ...profile.lots.map(([column]) => row.cells[column] ?? null), ...(entry.supplierId === 'systeme' ? [row.cells.E, row.cells.AX, row.cells.AY, row.cells.AZ] : [])]);
        if (item.inboundRows.has(fingerprint)) {
          report.duplicateRows++;
          addIssue('duplicate-inbound', 'Повторная строка того же товара с теми же партиями не сложена повторно. Проверьте дубликат.', sourceFor(entry, sheet, row), product, 'info');
          continue;
        }
        item.inboundRows.add(fingerprint);
        if (entry.supplierId === 'systeme') {
          const category = identity(row.cells.E);
          if (category) {
            const categoryId = `${entry.supplierId}:category:${category}`;
            categories.set(categoryId, { id: categoryId, name: `${SUPPLIERS[entry.supplierId]} — категория ${category}` });
            product.categoryId = categoryId;
          }
          const quantity = valueAt(item, row, 'AZ', 'free-stock', product);
          const reserve = valueAt(item, row, 'AY', 'reserve', product);
          uniqueRecord(item, row, product, product._state.stocks, 'free:null', { date: null, month: null, quantity, basis: 'free', reserve, reserveSource: sourceFor(entry, sheet, row, 'AY'), gross: numeric(row.cells.AX), grossSource: sourceFor(entry, sheet, row, 'AX'), source: sourceFor(entry, sheet, row, 'AZ') }, product.stocks, 'свободного остатка');
          if (quantity < 0) addIssue('negative-stock', 'Отрицательный свободный остаток сохранён для проверки; доступный запас не может быть отрицательным.', sourceFor(entry, sheet, row, 'AZ'), product);
        }
        for (const [column, label] of profile.lots) {
          const quantity = valueAt(item, row, column, 'inbound', product, false);
          if (quantity == null || quantity === 0) continue;
          const text = clean(label);
          const deadline = /поступление\s+до\s+(\d{2}\.\d{2}\.\d{4})/i.exec(text)?.[1];
          const eta = deadline ? dateValue(deadline) : dateValue(text);
          const short = !eta && /\b(\d{2})\.(\d{2})(?!\.\d)/.exec(text);
          const etaMonthDay = short && Number(short[1]) <= 31 && Number(short[2]) <= 12 ? `${short[2]}-${short[1]}` : null;
          product.inbound.push({ quantity, eta, etaMonthDay, etaType: eta ? (deadline ? 'deadline' : 'exact') : 'year-missing', source: sourceFor(entry, sheet, row, column) });
          if (!eta) addIssue('missing-eta-year', 'В заголовке поставки нет полного года/даты. Дата требует явного допущения менеджера.', sourceFor(entry, sheet, profile.header, column), product);
          if (eta) { file.periodStart = earliest(file.periodStart, eta); file.periodEnd = latest(file.periodEnd, eta); }
        }
      }
    }
    file.products = item.fileProducts.size;
  }
  let lastDate = null;
  let historyStart = null;
  for (const supplier of suppliers.values()) {
    if (supplier.detailPeriod.end) lastDate = latest(lastDate, supplier.detailPeriod.end);
  }
  if (!lastDate) throw new Error('В подробных продажах нет дат реализованных движений: нельзя определить дату расчёта по содержимому.');
  const asOf = plusDay(lastDate);
  for (const product of products.values()) {
    const supplier = suppliers.get(product.supplierId);
    product.monthlySales.sort((a, b) => a.month.localeCompare(b.month));
    product.detailMonthly.sort((a, b) => a.month.localeCompare(b.month) || a.warehouseId.localeCompare(b.warehouseId));
    if (product.monthlySales.length) historyStart = earliest(historyStart, `${product.monthlySales[0].month}-01`);
    if (!product.code) product.warnings.push('Нет кода 1С; товар сопоставлен только по уникальному артикулу поставщика.');
    if (product.packSize == null) product.warnings.push('Кратность упаковки неизвестна: требуется выбранное допущение или ручное значение.');
    if (product.moq == null) product.warnings.push('Минимальная партия неизвестна: требуется выбранное допущение или ручное значение.');
    const absent = ['moq', 'monthly', 'stocks', 'detail', 'inbound'].filter(type => !product._state.types.has(type));
    if (absent.length) report.unmatched.push({ productId: product.id, missingSources: absent });
    const detailByMonth = new Map();
    for (const record of product.detailMonthly) {
      detailByMonth.set(record.month, (detailByMonth.get(record.month) || 0) + record.positive + record.negative);
      if (record.negative < 0) report.corrections.push({ productId: product.id, month: record.month, warehouseId: record.warehouseId, negative: record.negative, returns: record.returns, corrections: record.corrections, source: record.source });
    }
    for (const record of product.monthlySales) {
      if (record.quantity == null || !supplier.detailPeriod.start || `${record.month}-01` < supplier.detailPeriod.start || record.month >= supplier.detailPeriod.end.slice(0, 7) || !detailByMonth.has(record.month)) continue;
      const detailNet = detailByMonth.get(record.month);
      report.reconciliation.push({ productId: product.id, month: record.month, detailNet, monthlyNet: record.quantity, difference: detailNet - record.quantity, status: 'scope-unconfirmed', scope: 'global', monthlySource: record.source, detailSource: product.detailMonthly.filter(r => r.month === record.month).map(r => r.source).join(' / ') });
    }
  }
  for (const supplier of suppliers.values()) {
    const list = [...products.values()].filter(product => product.supplierId === supplier.id);
    report.suppliers.push({ id: supplier.id, name: supplier.name, productCount: list.length, files: report.files.filter(file => file.supplierId === supplier.id).length, monthlyProducts: list.filter(product => product.monthlySales.length).length, detailProducts: list.filter(product => product.detailMonthly.length).length, stockProducts: list.filter(product => product.stocks.length).length, inboundProducts: list.filter(product => product.inbound.length).length, detailPeriod: supplier.detailPeriod, unknownPack: list.filter(product => product.packSize == null).length, unknownMoq: list.filter(product => product.moq == null).length });
  }
  report.productCount = products.size;
  report.fileCount = report.files.length;
  report.reconciliationStatus = 'scope-unconfirmed';
  report.snapshotDate = null;
  return { schemaVersion: 2, isDemo: false, name: 'Локальные Excel — SystemElectric / ИЭК', asOf, historyStart: historyStart || [...suppliers.values()].map(s => s.detailPeriod.start).filter(Boolean).sort()[0], suppliers: [...suppliers.values()], warehouses: [...warehouses.values()], categories: [...categories.values()], products: [...products.values()], report };
}
