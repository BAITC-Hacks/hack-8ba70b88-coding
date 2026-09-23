import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDemoData } from '../src/demo.js';

const directory = new URL('../data/', import.meta.url);
const destination = new URL('../data/demo.json', import.meta.url);
const data = createDemoData();
await mkdir(directory, { recursive: true });
await writeFile(destination, `${JSON.stringify(data)}\n`, 'utf8');
console.log(`Демонстрационные данные: ${fileURLToPath(destination)}`);
console.log(`${data.products.length} товаров, ${data.warehouses.length} склада, ${data.sales.length} строк продаж, ${data.availability.length} дней наличия.`);
