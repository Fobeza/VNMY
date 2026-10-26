/* VNMY — собирает файлы, без которых не обойтись при открытии index.html
 * двойным щелчком (file://):
 *
 *   bundle.js            — те же модули из js/, собранные в один обычный скрипт
 *                          (браузер не грузит ES-модули с диска из-за CORS);
 *   stories/builtin.js   — встроенные истории из stories/ в виде обычного скрипта
 *                          (fetch() с file:// тоже запрещён).
 *
 * Запуск: npm run build   (после правок в js/ или stories/)
 * Файлы коммитятся, поэтому для игры сборка не нужна — только для разработки.
 */
import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

export async function buildBundle() {
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, 'js/app.js')],
    bundle: true,
    format: 'iife',
    target: ['es2020'],
    minify: true,
    write: false,
    legalComments: 'none',
    logLevel: 'silent',
  });
  return `/* VNMY — сборка js/* для открытия с диска (file://).\n * Не правим руками: npm run build\n */\n${result.outputFiles[0].text}`;
}

/** Встроенные истории вместе с baseUrl — на file:// картинки грузятся относительно index.html. */
export async function buildBuiltinStories() {
  let names = ['demo'];
  try {
    const index = JSON.parse(await fs.readFile(path.join(ROOT, 'stories/index.json'), 'utf8'));
    names = Array.isArray(index) ? index : index.stories || names;
  } catch { /* оставляем демо */ }

  const stories = [];
  for (const name of names) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(ROOT, `stories/${name}/story.json`), 'utf8'));
      raw.baseUrl = `stories/${name}/`;
      raw._builtin = name;
      stories.push(raw);
    } catch (err) {
      console.warn(`[vnmy] пропускаю историю «${name}»:`, err.message);
    }
  }
  return `/* VNMY — встроенные истории для открытия с диска (file://).\n * Не правим руками: npm run build\n */\nwindow.__VNMY_BUILTIN_STORIES__ = ${JSON.stringify(stories)};\n`;
}

async function main() {
  const bundle = await buildBundle();
  const builtin = await buildBuiltinStories();
  await fs.writeFile(path.join(ROOT, 'bundle.js'), bundle);
  await fs.writeFile(path.join(ROOT, 'stories/builtin.js'), builtin);
  const kb = (s) => `${Math.round(Buffer.byteLength(s) / 1024)} КБ`;
  console.log(`bundle.js — ${kb(bundle)}, stories/builtin.js — ${kb(builtin)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
