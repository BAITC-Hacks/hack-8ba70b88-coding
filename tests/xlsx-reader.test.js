import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readXlsx } from '../src/xlsx-reader.js';

// All workbook fixtures are fictional and generated in memory, never real supplier data.
function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}

function zip(files, method = 8) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const compressed = method === 8 ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, filename, compressed);
    directory.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

const relType = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
function workbook(sheetXml, extra = {}) {
  return {
    '_rels/.rels': `<Relationships><Relationship Id="r1" Type="${relType}officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': '<workbook xmlns:r="r"><workbookPr date1904="0"/><sheets><sheet name="Тест &amp; данные" r:id="r1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="r1" Type="${relType}worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Type="${relType}sharedStrings" Target="sharedStrings.xml"/><Relationship Id="r3" Type="${relType}styles" Target="styles.xml"/></Relationships>`,
    'xl/sharedStrings.xml': '<sst><si><t>000123</t></si><si><r><t>Арти</t></r><r><t>кул&#x20;А&#38;Б</t></r><rPh><t>ignored pronunciation</t></rPh></si></sst>',
    'xl/styles.xml': '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="dd.mm.yyyy"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': sheetXml,
    ...extra,
  };
}

test('XLSX: raw values, rich text, leading zeroes, dates, cached formula and sparse source rows', () => {
  const result = readXlsx(zip(workbook(`<x:worksheet xmlns:x="x"><x:dimension ref="A1:L100001"/><x:sheetData>
    <x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1" t="s"><x:v>1</x:v></x:c>
    <x:c r="C1" t="inlineStr"><x:is><x:r><x:t>  Склад </x:t></x:r><x:r><x:t>&lt;Юг&gt; &#1040;</x:t></x:r></x:is></x:c>
    <x:c r="D1"><x:v>0</x:v></x:c><x:c r="E1"/><x:c r="F1" s="1"><x:v>45352</x:v></x:c>
    <x:c r="G1" s="2"><x:v>45353.5</x:v></x:c><x:c r="H1" t="b"><x:v>1</x:v></x:c>
    <x:c r="I1"><x:f>D1+2</x:f><x:v>2</x:v></x:c><x:c r="J1" t="str"><x:f>CONCAT(A1)</x:f><x:v>000123</x:v></x:c>
    <x:c r="K1" t="d"><x:v>2024-03-01T00:00:00Z</x:v></x:c><x:c r="L1"><x:v>-12.5</x:v></x:c></x:row>
    <x:row r="100001"><x:c r="AA100001"><x:v>17</x:v></x:c><x:c><x:v>18</x:v></x:c></x:row>
    </x:sheetData><x:mergeCells><x:mergeCell ref="A2:C2"/></x:mergeCells></x:worksheet>`)), { filename: 'fictional.xlsx' });
  assert.equal(result.filename, 'fictional.xlsx');
  assert.equal(result.date1904, false);
  assert.equal(result.sheets[0].name, 'Тест & данные');
  assert.equal(result.sheets[0].dimension, 'A1:L100001');
  assert.deepEqual(result.sheets[0].merges, ['A2:C2']);
  assert.equal(result.sheets[0].rows.length, 2);
  const first = result.sheets[0].rows[0];
  assert.deepEqual(first.cells, { A: '000123', B: 'Артикул А&Б', C: '  Склад <Юг> А', D: 0, F: 45352, G: 45353.5, H: true, I: 2, J: '000123', K: '2024-03-01T00:00:00Z', L: -12.5 });
  assert.equal(first.cellMeta.F.dateFormatted, true);
  assert.equal(first.cellMeta.G.numberFormat, 'dd.mm.yyyy');
  assert.equal(first.cellMeta.D.dateFormatted, false);
  assert.equal(first.cellMeta.I.formula, 'D1+2');
  assert.deepEqual(result.sheets[0].rows[1].cells, { AA: 17, AB: 18 });
  assert.deepEqual(result.warnings, []);
});

test('XLSX: warns for missing formula cache and Excel errors, does not manufacture zeroes', () => {
  const result = readXlsx(zip(workbook('<worksheet><sheetData><row r="8"><c r="A8"><f>SUM(B8)</f></c><c r="B8" t="e"><v>#REF!</v></c><c r="C8"><v/></c><c r="D8" t="inlineStr"><is><t/></is></c><c r="E8" t="b"><v>0</v></c></row></sheetData></worksheet>')));
  assert.deepEqual(result.sheets[0].rows[0].cells, { B: '#REF!', D: '', E: false });
  assert.equal(result.sheets[0].rows[0].cellMeta.B.error, '#REF!');
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /A8.*формула/);
  assert.match(result.warnings[1], /B8.*#REF!/);
});

test('XLSX: accepts stored ZIP, 1904 dates, URI relationship names, Unicode and single quote attributes', () => {
  const files = workbook('<worksheet><sheetData><row><c t="inlineStr"><is><t><![CDATA[Example > text]]></t></is></c></row></sheetData></worksheet>', {
    'xl/workbook.xml': "<workbook xmlns:q='r'><workbookPr date1904='true'/><sheets><sheet name='Поставщик &apos;А&apos;' q:id='r1'/></sheets></workbook>",
    'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="r1" Type="${relType}worksheet" Target="/xl/worksheets/%D0%9B%D0%B8%D1%81%D1%82.xml"/></Relationships>`,
  });
  files['xl/worksheets/Лист.xml'] = files['xl/worksheets/sheet1.xml'];
  const result = readXlsx(zip(files, 0));
  assert.equal(result.date1904, true);
  assert.equal(result.sheets[0].name, "Поставщик 'А'");
  assert.equal(result.sheets[0].rows[0].cells.A, 'Example > text');
});

test('XLSX: external links are never fetched; unsupported sheet types are reported', () => {
  const result = readXlsx(zip(workbook('<worksheet/>', {
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Remote" r:id="r1"/><sheet name="Chart" r:id="r2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="r1" Type="${relType}worksheet" TargetMode="External" Target="https://invalid.example/secret"/><Relationship Id="r2" Type="${relType}chartsheet" Target="chartsheets/sheet1.xml"/></Relationships>`,
  })));
  assert.deepEqual(result.sheets, []);
  assert.equal(result.warnings.length, 2);
});

test('XLSX: ZIP integrity, unsupported encryption/compression and expansion bounds fail explicitly', () => {
  assert.throws(() => readXlsx(Buffer.from('not xlsx')), /Excel/);
  const original = zip(workbook('<worksheet/>'));
  const directory = original.readUInt32LE(original.length - 6);
  for (const [field, size, value, message] of [[8, 2, 0x801, /зашифрованные/], [10, 2, 12, /сжатие/], [24, 4, 0x20000000, /размер распаковки/], [42, 4, 0xfffffff0, /заголовок/]]) {
    const corrupted = Buffer.from(original);
    corrupted[`writeUInt${size * 8}LE`](value, directory + field);
    assert.throws(() => readXlsx(corrupted), message);
  }
  const crcBroken = Buffer.from(original);
  crcBroken.writeUInt32LE(0, directory + 16);
  assert.throws(() => readXlsx(crcBroken), /CRC32/);
  assert.throws(() => readXlsx(zip({ '../escaped.xml': '' })), /небезопасное имя/);
});

test('XLSX: malformed XML, DTD, invalid numbers and incorrect sharedStrings are rejected', () => {
  for (const [xml, error] of [
    ['<!DOCTYPE worksheet [<!ENTITY evil SYSTEM "file:///sensitive">]><worksheet/>', /DTD/],
    ['<worksheet><sheetData></worksheet>', /вложенность/],
    ['<worksheet><sheetData><row r="1"><c r="A1"><v>NaN</v></c></row></sheetData></worksheet>', /число/],
    ['<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>99</v></c></row></sheetData></worksheet>', /sharedStrings/],
    ['<worksheet><sheetData><row r="1"><c r="A2"><v>1</v></c></row></sheetData></worksheet>', /адрес/],
  ]) assert.throws(() => readXlsx(zip(workbook(xml))), error);
});

test('XLSX: all rows are read without a hidden product limit or daily expansion', () => {
  const rows = Array.from({ length: 12001 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('');
  const result = readXlsx(zip(workbook(`<worksheet><sheetData>${rows}</sheetData></worksheet>`)));
  assert.equal(result.sheets[0].rows.length, 12001);
  assert.equal(result.sheets[0].rows.at(-1).cells.A, 12000);
});
