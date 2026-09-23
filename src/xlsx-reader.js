import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

// This reader only reads bytes in memory. It neither extracts files nor follows URLs.
// Limits fail explicitly; they never truncate the workbook or its product rows.
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 768 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function check(condition, message) {
  if (!condition) throw new Error(`Excel: ${message}`);
}

function decodeText(bytes) {
  try { return utf8.decode(bytes); }
  catch { throw new Error('Excel: некорректная кодировка UTF-8 в XLSX.'); }
}

function zipReader(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  check(buffer.length >= 22 && buffer.length <= MAX_ARCHIVE_BYTES, 'размер ZIP вне допустимых границ (максимум 256 МиБ).');
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) {
      end = offset;
      break;
    }
  }
  check(end >= 0, 'файл не является корректным ZIP/XLSX. Старый формат XLS не поддерживается.');
  check(buffer.readUInt16LE(end + 4) === 0 && buffer.readUInt16LE(end + 6) === 0, 'многотомный ZIP не поддерживается.');
  const count = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryStart = buffer.readUInt32LE(end + 16);
  check(count !== 0xffff && directorySize !== 0xffffffff && directoryStart !== 0xffffffff, 'ZIP64 не поддерживается.');
  check(count === buffer.readUInt16LE(end + 8), 'некорректное число записей ZIP.');
  check(directoryStart + directorySize === end, 'повреждена центральная директория ZIP.');
  const entries = new Map();
  let position = directoryStart;
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    check(position + 46 <= end && buffer.readUInt32LE(position) === 0x02014b50, 'повреждена запись центральной директории ZIP.');
    const flags = buffer.readUInt16LE(position + 8);
    const method = buffer.readUInt16LE(position + 10);
    const checksum = buffer.readUInt32LE(position + 16);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const size = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const localOffset = buffer.readUInt32LE(position + 42);
    const next = position + 46 + nameLength + extraLength + commentLength;
    check(next <= end, 'запись ZIP выходит за границы файла.');
    const name = decodeText(buffer.subarray(position + 46, position + 46 + nameLength));
    check(name && !name.includes('\0') && !name.includes('\\') && !name.startsWith('/') && !name.split('/').includes('..'), 'небезопасное имя внутри ZIP.');
    check(!(flags & 1) && !(flags & 64), 'зашифрованные XLSX не поддерживаются.');
    check(method === 0 || method === 8, `неподдерживаемое сжатие ZIP (${method}).`);
    check(size !== 0xffffffff && compressedSize !== 0xffffffff && localOffset !== 0xffffffff, 'ZIP64 не поддерживается.');
    expanded += size;
    check(size <= MAX_ENTRY_BYTES && expanded <= MAX_TOTAL_BYTES, 'превышен безопасный размер распаковки XLSX (256 МиБ на запись, 768 МиБ всего).');
    check(!entries.has(name), `повторяющаяся запись ZIP: ${name}.`);
    check(localOffset + 30 <= directoryStart && buffer.readUInt32LE(localOffset) === 0x04034b50, 'повреждён локальный заголовок ZIP.');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    check(dataStart + compressedSize <= directoryStart, 'содержимое ZIP выходит за границы файла.');
    check(buffer.readUInt16LE(localOffset + 8) === method && buffer.readUInt16LE(localOffset + 6) === flags, 'локальный заголовок ZIP не совпадает с центральным.');
    check(decodeText(buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength)) === name, 'имя в локальном заголовке ZIP не совпадает с центральным.');
    entries.set(name, { size, compressedSize, dataStart, method, checksum });
    position = next;
  }
  check(position === end, 'неверный размер центральной директории ZIP.');
  return {
    has: name => entries.has(name),
    text(name) {
      const entry = entries.get(name);
      check(entry, `в архиве отсутствует ${name}.`);
      const bytes = buffer.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
      let raw;
      try { raw = entry.method === 0 ? bytes : inflateRawSync(bytes, { maxOutputLength: Math.max(1, entry.size) }); }
      catch { throw new Error(`Excel: невозможно распаковать ${name}.`); }
      check(raw.length === entry.size && crc32(raw) === entry.checksum, `повреждены данные ${name} (размер или CRC32).`);
      return decodeText(raw);
    },
  };
}

function entities(text) {
  return text.replace(/&([^;\s]+);/g, (entity, name) => {
    const basic = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(basic, name)) return basic[name];
    if (/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(name)) {
      const value = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      check(value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff), 'некорректная числовая XML-сущность.');
      return String.fromCodePoint(value);
    }
    throw new Error(`Excel: неизвестная XML-сущность ${entity}.`);
  });
}

function attributes(text) {
  const attrs = {};
  const expression = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of text.matchAll(expression)) attrs[match[1]] = entities(match[2] ?? match[3]);
  return attrs;
}

// Namespace prefixes are legal in all OOXML parts, including sheet cells.
function* xmlEvents(xml) {
  check(!/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml), 'DTD и внешние XML-сущности запрещены.');
  const expression = /<!--[^]*?-->|<!\[CDATA\[[^]*?\]\]>|<\?[^]*?\?>|<\/?[A-Za-z_](?:[^<>"']|"[^"]*"|'[^']*')*>|[^<]+/g;
  let consumed = 0;
  const stack = [];
  for (const match of xml.matchAll(expression)) {
    check(match.index === consumed, 'повреждён XML.');
    consumed = match.index + match[0].length;
    const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) { yield { kind: 'text', text: token.slice(9, -3) }; continue; }
    if (token[0] !== '<') { yield { kind: 'text', text: entities(token) }; continue; }
    const closing = token[1] === '/';
    const fullName = /^<\/?([^\s/>]+)/.exec(token)?.[1];
    check(fullName, 'повреждено имя XML-элемента.');
    const name = fullName.split(':').at(-1);
    if (closing) {
      check(stack.pop() === fullName, 'нарушена вложенность XML-элементов.');
      yield { kind: 'end', name };
    } else {
      yield { kind: 'start', name, attrs: attributes(token) };
      if (/\/\s*>$/.test(token)) yield { kind: 'end', name };
      else stack.push(fullName);
    }
  }
  check(consumed === xml.length && stack.length === 0, 'незавершённый XML.');
}

function relationships(zip, part) {
  const relPath = part ? `${path.posix.dirname(part)}/_rels/${path.posix.basename(part)}.rels` : '_rels/.rels';
  const result = new Map();
  if (!zip.has(relPath)) return result;
  for (const event of xmlEvents(zip.text(relPath))) {
    if (event.kind !== 'start' || event.name !== 'Relationship') continue;
    const attrs = event.attrs;
    if (attrs.TargetMode === 'External') {
      result.set(attrs.Id, { external: true, type: attrs.Type });
      continue;
    }
    let target;
    try { target = decodeURIComponent(attrs.Target || ''); }
    catch { throw new Error('Excel: некорректная ссылка на часть книги.'); }
    check(target && !target.includes('\\') && !/^[a-z][a-z0-9+.-]*:/i.test(target), 'некорректная внутренняя ссылка книги.');
    target = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(part ? path.posix.dirname(part) : '', target));
    check(!target.startsWith('../'), 'внутренняя ссылка выходит за границы книги.');
    result.set(attrs.Id, { target, type: attrs.Type, external: false });
  }
  return result;
}

function sharedStrings(xml) {
  const result = [];
  let value = null;
  let inText = false;
  let phonetic = 0;
  for (const event of xmlEvents(xml)) {
    if (event.kind === 'start') {
      if (event.name === 'si') value = '';
      if (event.name === 'rPh') phonetic++;
      if (event.name === 't' && !phonetic) inText = true;
    } else if (event.kind === 'text') {
      if (value !== null && inText && !phonetic) value += event.text;
    } else {
      if (event.name === 't') inText = false;
      if (event.name === 'rPh') phonetic--;
      if (event.name === 'si') { result.push(value); value = null; }
    }
  }
  return result;
}

const builtinDateFormats = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const builtinFormats = { 0: 'General', 1: '0', 2: '0.00', 9: '0%', 10: '0.00%', 14: 'mm-dd-yy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yy h:mm', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0' };

function styles(xml) {
  const formats = new Map();
  const result = [];
  let inCellXfs = false;
  for (const event of xmlEvents(xml)) {
    if (event.kind === 'start') {
      if (event.name === 'numFmt') formats.set(Number(event.attrs.numFmtId), event.attrs.formatCode);
      if (event.name === 'cellXfs') inCellXfs = true;
      if (event.name === 'xf' && inCellXfs) {
        const numFmtId = Number(event.attrs.numFmtId || 0);
        const numberFormat = formats.get(numFmtId) ?? builtinFormats[numFmtId] ?? null;
        const stripped = (numberFormat || '').replace(/"[^"]*"|\\.|\[(?![hms]+\])[^\]]*\]|_.|\*./gi, '');
        result.push({ numFmtId, numberFormat, dateFormatted: builtinDateFormats.has(numFmtId) || /[ymdhs]/i.test(stripped) });
      }
    } else if (event.kind === 'end' && event.name === 'cellXfs') inCellXfs = false;
  }
  return result;
}

function columnNumber(column) {
  let number = 0;
  for (const letter of column) number = number * 26 + letter.charCodeAt(0) - 64;
  return number;
}

function columnName(number) {
  let name = '';
  do { number--; name = String.fromCharCode(65 + number % 26) + name; number = Math.floor(number / 26); } while (number);
  return name;
}

function worksheet(xml, name, strings, styleList, warnings) {
  const sheet = { name, rows: [], merges: [], dimension: null };
  let row = null;
  let lastRow = 0;
  let column = 0;
  let cell = null;
  let capture = '';
  let inInline = false;
  let phonetic = 0;
  for (const event of xmlEvents(xml)) {
    if (event.kind === 'start') {
      const attrs = event.attrs;
      if (event.name === 'dimension') sheet.dimension = attrs.ref || null;
      if (event.name === 'mergeCell' && attrs.ref) sheet.merges.push(attrs.ref);
      if (event.name === 'row') {
        const number = Number(attrs.r || lastRow + 1);
        check(Number.isInteger(number) && number >= 1 && number <= 1048576, `некорректный номер строки листа «${name}».`);
        row = { number, cells: {}, cellMeta: {} };
        lastRow = number;
        column = 0;
      }
      if (event.name === 'c') {
        check(row, `ячейка вне строки листа «${name}».`);
        let letters;
        if (attrs.r) {
          const ref = /^([A-Z]+)([1-9][0-9]*)$/.exec(attrs.r);
          check(ref && Number(ref[2]) === row.number, `некорректный адрес ячейки ${attrs.r}.`);
          letters = ref[1];
          column = columnNumber(letters);
        } else letters = columnName(++column);
        check(column <= 16384, `столбец за пределами XLSX на листе «${name}».`);
        const styleIndex = Number(attrs.s || 0);
        check(Number.isInteger(styleIndex) && styleIndex >= 0, 'некорректный индекс стиля.');
        cell = { column: letters, type: attrs.t || 'n', styleIndex, value: '', inline: '', formula: '', hasValue: false, hasFormula: false };
      }
      if (cell) {
        if (event.name === 'v') { capture = 'value'; cell.hasValue = true; }
        if (event.name === 'f') { capture = 'formula'; cell.hasFormula = true; }
        if (event.name === 'is') inInline = true;
        if (event.name === 'rPh') phonetic++;
        if (event.name === 't' && inInline && !phonetic) capture = 'inline';
      }
    } else if (event.kind === 'text') {
      if (cell && capture && !phonetic) cell[capture] += event.text;
    } else {
      if (['v', 'f', 't'].includes(event.name)) capture = '';
      if (event.name === 'rPh') phonetic--;
      if (event.name === 'is') inInline = false;
      if (event.name === 'c' && cell) {
        const ref = `${cell.column}${row.number}`;
        const meta = { type: cell.type, styleIndex: cell.styleIndex, ...(styleList[cell.styleIndex] || { numFmtId: 0, numberFormat: 'General', dateFormatted: false }) };
        if (cell.hasFormula) meta.formula = cell.formula;
        let value;
        if (cell.type === 'inlineStr') value = cell.inline;
        else if (cell.hasValue && (cell.value !== '' || cell.type === 'str')) {
          if (cell.type === 's') {
            const index = Number(cell.value);
            check(Number.isInteger(index) && index >= 0 && index < strings.length, `неизвестная строка sharedStrings в ${name}!${ref}.`);
            value = strings[index];
          } else if (cell.type === 'b') {
            check(cell.value === '0' || cell.value === '1', `некорректное логическое значение ${name}!${ref}.`);
            value = cell.value === '1';
          } else if (cell.type === 'n') {
            value = Number(cell.value);
            check(Number.isFinite(value), `некорректное число ${name}!${ref}.`);
          } else value = cell.value;
          if (cell.type === 'e') { meta.error = value; warnings.push(`${name}!${ref}: ошибка Excel ${value}.`); }
        }
        if (cell.hasFormula && value === undefined) warnings.push(`${name}!${ref}: формула без сохранённого значения; откройте и пересчитайте книгу в Excel.`);
        if (value !== undefined) row.cells[cell.column] = value;
        row.cellMeta[cell.column] = meta;
        cell = null;
      }
      if (event.name === 'row' && row) { sheet.rows.push(row); row = null; }
    }
  }
  return sheet;
}

/** Read an OOXML .xlsx buffer locally. Cells contain raw values; dates stay Excel serials. */
export function readXlsx(buffer, { filename = '' } = {}) {
  const zip = zipReader(buffer);
  const warnings = [];
  const root = [...relationships(zip, '').values()].find(rel => rel.type?.endsWith('/officeDocument') && !rel.external);
  const workbookPart = root?.target || 'xl/workbook.xml';
  const rels = relationships(zip, workbookPart);
  const sheetDefinitions = [];
  let date1904 = false;
  for (const event of xmlEvents(zip.text(workbookPart))) {
    if (event.kind !== 'start') continue;
    if (event.name === 'workbookPr') date1904 = ['1', 'true'].includes(event.attrs.date1904);
    if (event.name === 'sheet') {
      const relation = Object.entries(event.attrs).find(([key]) => key === 'r:id' || key.endsWith(':id'))?.[1] || event.attrs.id;
      sheetDefinitions.push({ name: event.attrs.name, relation });
    }
  }
  const partOfType = suffix => [...rels.values()].find(rel => rel.type?.endsWith(`/${suffix}`) && !rel.external)?.target;
  const stringsPart = partOfType('sharedStrings');
  const stylesPart = partOfType('styles');
  const strings = stringsPart ? sharedStrings(zip.text(stringsPart)) : [];
  const styleList = stylesPart ? styles(zip.text(stylesPart)) : [];
  const sheets = [];
  for (const definition of sheetDefinitions) {
    const rel = rels.get(definition.relation);
    check(rel, `нет связи для листа «${definition.name}».`);
    if (rel.external) { warnings.push(`Лист «${definition.name}»: внешняя связь пропущена; внешние ресурсы не загружаются.`); continue; }
    if (!rel.type?.endsWith('/worksheet')) { warnings.push(`Лист «${definition.name}»: тип не является таблицей worksheet.`); continue; }
    sheets.push(worksheet(zip.text(rel.target), definition.name, strings, styleList, warnings));
  }
  return { filename, date1904, sheets, warnings };
}
