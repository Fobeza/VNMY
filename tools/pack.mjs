/* VNMY — упаковка новеллы в файл .vnmy для импорта в приложении.
 *
 *   npm run pack -- <папка> [файл.vnmy]
 *
 * <папка> — вселенная (universe.json + novels/<новелла>/…) или одна новелла
 * (story.json + assets/…). Перед упаковкой выполняется та же проверка, что
 * в npm run check: сценарий, картинки и маршруты из routes.json.
 * Файл .vnmy — обычный zip без сжатия (webp уже сжаты): его можно
 * распаковать любым архиватором и получить исходную папку обратно.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { scanSource } from './build.mjs';
import { validateStories } from './validate.mjs';
import { checkRoutes } from './check-routes.mjs';

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const SKIP = (name) => name.startsWith('.') || name.startsWith('_') || name === 'node_modules' || name === 'raw'
  || /\.(vnmy|zip)$/i.test(name);

async function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(full, `${prefix}${entry.name}/`));
    else if (entry.isFile()) out.push({ name: `${prefix}${entry.name}`, full });
  }
  return out;
}

/** Zip «без сжатия» (метод 0) — его читает js/zip.js в любом браузере. */
export async function writeZip(files, out) {
  const handle = await fs.open(out, 'w');
  const central = [];
  let offset = 0;
  try {
    for (const { name, full } of files) {
      const data = await fs.readFile(full);
      const nameBuf = Buffer.from(name, 'utf8');
      const crc = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6); // имена в UTF-8
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      await handle.write(Buffer.concat([local, nameBuf]));
      await handle.write(data);
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(20, 4);
      entry.writeUInt16LE(20, 6);
      entry.writeUInt16LE(0x0800, 8);
      entry.writeUInt32LE(crc, 16);
      entry.writeUInt32LE(data.length, 20);
      entry.writeUInt32LE(data.length, 24);
      entry.writeUInt16LE(nameBuf.length, 28);
      entry.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([entry, nameBuf]));
      offset += 30 + nameBuf.length + data.length;
      if (offset > 0xffffffff) throw new Error('Новелла больше 4 ГБ — так не упаковать');
    }
    const dir = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(offset, 16);
    await handle.write(Buffer.concat([dir, end]));
  } finally {
    await handle.close();
  }
}

async function main() {
  const [source, target] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  if (!source) {
    console.error('Использование: npm run pack -- <папка новеллы или вселенной> [файл.vnmy]');
    process.exit(1);
  }
  const base = path.resolve(source);
  const scan = await scanSource(base);
  if (!scan.some((u) => u.novels.length)) throw new Error(`В «${source}» нет story.json`);
  if (!process.argv.includes('--no-check')) {
    const result = await validateStories(scan);
    const { routes } = await checkRoutes(scan);
    console.log(`Проверено новелл: ${result.novels}; предупреждений: ${result.warnings}; маршрутов: ${routes}`);
  }
  const files = await listFiles(base);
  if (files.length > 0xffff) throw new Error('Слишком много файлов для одного пакета');
  const out = path.resolve(target || `${path.basename(base)}.vnmy`);
  if (path.relative(base, out) && !path.relative(base, out).startsWith('..')) {
    throw new Error('Положите .vnmy вне упаковываемой папки');
  }
  await writeZip(files, out);
  const { size } = await fs.stat(out);
  console.log(`${path.relative(process.cwd(), out) || out} — ${files.length} файлов, ${(size / 1024 / 1024).toFixed(1)} МБ`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
