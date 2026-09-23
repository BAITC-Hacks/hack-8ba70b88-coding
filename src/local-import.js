import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readXlsx } from './xlsx-reader.js';
import { importSupplierWorkbooks } from './excel-import.js';

export function defaultSourcePaths() {
  return {
    systeme: process.env.SYSTEME_DATA_DIR || path.join(os.homedir(), 'Downloads', 'Systeme electric', 'Systeme electric'),
    iek: process.env.IEK_DATA_DIR || path.join(os.homedir(), 'Downloads', 'IEK', 'IEK'),
  };
}

/** Reads selected local folders only; never writes or transmits source workbooks. */
export async function importLocalSources(paths = defaultSourcePaths()) {
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) throw new Error('Нужны локальные пути к папкам поставщиков.');
  const entries = [];
  for (const supplierId of ['systeme', 'iek']) {
    const directory = paths[supplierId];
    if (directory === '' || directory == null) continue;
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error(`${supplierId}: укажите абсолютный путь к локальной папке.`);
    if (directory.startsWith('\\\\') || directory.startsWith('//')) throw new Error('Сетевые пути не поддерживаются: выберите локальную папку.');
    let files;
    try { files = (await readdir(directory, { withFileTypes: true })).filter(file => file.isFile() && /\.xlsx$/i.test(file.name) && !file.name.startsWith('~$')).sort((a, b) => a.name.localeCompare(b.name)); }
    catch { throw new Error(`${supplierId}: папка недоступна. Проверьте локальный путь и права чтения.`); }
    if (!files.length) throw new Error(`${supplierId}: в папке не найдено XLSX-файлов.`);
    for (const file of files) {
      const filename = path.join(directory, file.name);
      const size = (await stat(filename)).size;
      if (size > 128 * 1024 * 1024) throw new Error(`${file.name}: размер превышает защитный предел 128 МиБ; файл не усечён.`);
      entries.push({ supplierId, filename: file.name, workbook: readXlsx(await readFile(filename), { filename: file.name }) });
    }
  }
  if (!entries.length) throw new Error('Укажите папку хотя бы одного поставщика.');
  return importSupplierWorkbooks(entries);
}
