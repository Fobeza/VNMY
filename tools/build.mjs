/* VNMY — собирает файлы для запуска без сервера:
 *
 *   bundle.js            — те же модули из js/, собранные в один обычный скрипт
 *                          (браузер не грузит ES-модули с диска из-за CORS);
 *   stories/builtin.js   — встроенные истории из stories/ обычным скриптом
 *                          (fetch() с file:// тоже запрещён);
 *   vnmy.html            — ВСЁ в одном файле: стили, движок, истории и картинки
 *                          (data:image/…). Его достаточно скачать на телефон
 *                          и открыть в браузере — рядом ничего не нужно.
 *
 * Запуск: npm run build   (после правок в js/, css/ или stories/)
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

const MIME = {
  webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif',
};

/** Картинки истории → data:image/…, чтобы файл был совсем один. */
async function inlineAssets(story, dirName) {
  const base = `stories/${dirName}/`;
  const cache = new Map();
  const inline = async (value) => {
    if (!value || typeof value !== 'string') return value;
    if (/^(data:|https?:|\/)/.test(value)) return value;
    const file = path.join(ROOT, base, value);
    if (!cache.has(file)) {
      const buffer = await fs.readFile(file);
      const ext = path.extname(file).slice(1).toLowerCase();
      cache.set(file, `data:${MIME[ext] || 'application/octet-stream'};base64,${buffer.toString('base64')}`);
    }
    return cache.get(file);
  };

  story.cover = await inline(story.cover);
  for (const item of story.media || []) item.url = await inline(item.url);
  for (const char of story.characters || []) {
    for (const key of Object.keys(char.sprites || {})) char.sprites[key] = await inline(char.sprites[key]);
  }
  for (const scene of story.scenes || []) {
    scene.bg = await inline(scene.bg);
    for (const step of scene.steps || []) step.bg = await inline(step.bg);
  }
  story.baseUrl = '';
  story._builtin = dirName;
  return story;
}

/** Один самодостаточный HTML: стили внутри, картинки в data:, никаких запросов. */
export async function buildStandalone() {
  const [bundle, html] = await Promise.all([
    buildBundle(),
    fs.readFile(path.join(ROOT, 'index.html'), 'utf8'),
  ]);

  const cssFiles = ['css/base.css', 'css/player.css', 'css/editor.css'];
  const css = (await Promise.all(cssFiles.map((file) => fs.readFile(path.join(ROOT, file), 'utf8')))).join('\n');

  let names = ['demo'];
  try {
    const index = JSON.parse(await fs.readFile(path.join(ROOT, 'stories/index.json'), 'utf8'));
    names = Array.isArray(index) ? index : index.stories || names;
  } catch { /* оставляем демо */ }

  const stories = [];
  for (const name of names) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(ROOT, `stories/${name}/story.json`), 'utf8'));
      stories.push(await inlineAssets(raw, name));
    } catch (err) {
      console.warn(`[vnmy] пропускаю историю «${name}»:`, err.message);
    }
  }

  const watchdog = `window.__vnmyBoot = setTimeout(function () {
  if (window.__VNMY_BOOTED) return;
  var fallback = document.getElementById('boot-fallback');
  if (fallback) fallback.hidden = false;
}, 1500);`;

  const builtin = `window.__VNMY_BUILTIN_STORIES__ = ${JSON.stringify(stories)};`;

  return html
    .replace(/\n\s*<link rel="preload"[^>]*>/, '')
    .replace(/\n\s*<link rel="manifest"[^>]*>/, '')
    .replace(/\n\s*<link rel="stylesheet"[^>]*>/g, '')
    .replace('</head>', () => `<style>\n${css}\n</style>\n</head>`)
    .replace(/<script>\s*\/\/ Если приложение не поднялось[\s\S]*?<\/script>/, () =>
      `<script>${watchdog}</script>\n<script>${builtin}</script>\n<script>${bundle}</script>`)
    .replace('<!doctype html>', '<!doctype html>\n<!-- VNMY 1.0 — один файл: движок, стили, истории и картинки внутри. Сборка: npm run build -->');
}

async function main() {
  const bundle = await buildBundle();
  const builtin = await buildBuiltinStories();
  const standalone = await buildStandalone();
  await fs.writeFile(path.join(ROOT, 'bundle.js'), bundle);
  await fs.writeFile(path.join(ROOT, 'stories/builtin.js'), builtin);
  await fs.writeFile(path.join(ROOT, 'vnmy.html'), standalone);
  const kb = (s) => `${Math.round(Buffer.byteLength(s) / 1024)} КБ`;
  console.log(`bundle.js — ${kb(bundle)}, stories/builtin.js — ${kb(builtin)}, vnmy.html — ${kb(standalone)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
