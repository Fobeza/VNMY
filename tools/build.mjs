/* VNMY — сборка файлов для запуска без сервера и манифеста историй.
 *
 * Что делает `npm run build`:
 *
 *   stories/index.json   — манифест библиотеки: какие вселенные и новеллы лежат в stories/.
 *                          Создаётся АВТОМАТИЧЕСКИ по папкам — руками не правим.
 *   bundle.js            — модули из js/, собранные в один обычный скрипт
 *                          (браузер не грузит ES-модули с диска из-за CORS);
 *   stories/builtin.js   — встроенные вселенные и новеллы обычным скриптом
 *                          (fetch() с file:// тоже запрещён);
 *   vnmy.html            — ВСЁ в одном файле: стили, движок, истории и картинки
 *                          (data:image/…). Достаточно скачать на телефон.
 *
 * Запуск: npm run build   (после правок в js/, css/ или stories/)
 * Собранные файлы коммитятся, поэтому для игры сборка не нужна — она нужна,
 * когда добавили/переименовали папку вселенной или новеллы.
 *
 * Структура исходников:
 *   stories/<вселенная>/universe.json
 *   stories/<вселенная>/novels/<новелла>/story.json
 *   stories/<вселенная>/novels/<новелла>/assets/…
 * Папки, начинающиеся с «_», считаются шаблонами и в сборку не попадают.
 */
import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const STORIES = path.join(ROOT, 'stories');

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

const isTemplate = (name) => name.startsWith('_') || name.startsWith('.');

async function readJSON(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

/**
 * Обходит stories/ и возвращает вселенные с новеллами:
 * [{ dir, universe, novels: [{ dir, story }] }]
 */
export async function scanStories() {
  const universes = [];
  let entries = [];
  try {
    entries = await fs.readdir(STORIES, { withFileTypes: true });
  } catch {
    return universes;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || isTemplate(entry.name)) continue;
    const dir = entry.name;
    let universe;
    try {
      const file = await resolveContainedFile(`stories/${dir}`, 'universe.json', 'Universe');
      universe = await readJSON(file);
    } catch {
      console.warn(`[vnmy] пропускаю «stories/${dir}»: нет universe.json`);
      continue;
    }
    universe.id = String(universe.id || dir);
    universe.title = String(universe.title || dir);

    const novels = [];
    let novelDirs = [];
    try {
      novelDirs = (await fs.readdir(path.join(STORIES, dir, 'novels'), { withFileTypes: true }))
        .filter((d) => d.isDirectory() && !isTemplate(d.name))
        .map((d) => d.name)
        .sort();
    } catch {
      /* у вселенной пока нет новелл */
    }
    for (const novelDir of novelDirs) {
      try {
        const file = await resolveContainedFile(`stories/${dir}/novels/${novelDir}`, 'story.json', 'Story');
        const story = await readJSON(file);
        novels.push({ dir: novelDir, story });
      } catch (err) {
        console.warn(`[vnmy] пропускаю «stories/${dir}/novels/${novelDir}»: ${err.message}`);
      }
    }
    universes.push({ dir, universe, novels });
  }

  universes.sort((a, b) => (Number(a.universe.order) || 100) - (Number(b.universe.order) || 100)
    || a.dir.localeCompare(b.dir));
  return universes;
}

/** Манифест библиотеки: его читает приложение при запуске через сервер. */
export function manifestOf(scan) {
  const manifest = {
    schema: 2,
    generated: 'npm run build',
    note: 'Создаётся автоматически по папкам stories/. Руками не правим.',
    universes: scan.map(({ dir, universe, novels }) => ({
      id: universe.id,
      dir,
      title: universe.title,
      author: universe.author || '',
      description: universe.description || '',
      cover: universe.cover || '',
      accent: universe.accent || '',
      order: Number(universe.order) || 100,
      novels: novels.map(({ dir: novelDir, story }) => ({
        id: String(story.id || novelDir),
        dir: novelDir,
        title: String(story.title || novelDir),
      })),
    })),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function buildManifest(scan) {
  return manifestOf(scan || await scanStories());
}

/** Встроенная библиотека вместе с baseUrl — на file:// картинки грузятся относительно index.html. */
export async function buildBuiltinStories(scan) {
  scan = scan || await scanStories();
  const universes = scan.map(({ dir, universe, novels }) => ({
    ...universe,
    baseUrl: '',
    novels: novels.map(({ dir: novelDir, story }) => ({
      ...story,
      universe: universe.id,
      baseUrl: `stories/${dir}/novels/${novelDir}/`,
      _builtin: `${dir}/novels/${novelDir}`,
    })),
  }));
  return `/* VNMY — встроенные вселенные и новеллы для открытия с диска (file://).
 * Не правим руками: npm run build
 */
window.__VNMY_BUILTIN_LIBRARY__ = ${jsonForInlineScript({ schema: 2, universes })};
`;
}

const MIME = {
  webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif',
};

function isWithinDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`));
}

async function resolveContainedFile(base, value, kind = 'Asset') {
  const sourceDirectory = path.resolve(ROOT, base);
  const file = path.resolve(sourceDirectory, value);
  if (!isWithinDirectory(sourceDirectory, file)) {
    throw new Error(`${kind} path escapes its source directory: ${value}`);
  }

  // Lexical containment is not enough if a file or directory is a symlink.
  const realRoot = await fs.realpath(ROOT);
  const expectedDirectory = path.resolve(realRoot, base);
  const [realDirectory, realFile] = await Promise.all([
    fs.realpath(sourceDirectory),
    fs.realpath(file),
  ]);
  if (realDirectory !== expectedDirectory || !isWithinDirectory(realDirectory, realFile)) {
    throw new Error(`${kind} symlink escapes its source directory: ${value}`);
  }
  return realFile;
}

function inlineScript(source) {
  // The HTML tokenizer closes a script even if `</script>` appears in a JS string.
  return source.replace(/<\/script/gi, '<\\/script');
}

function jsonForInlineScript(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => ({
    '<': '\\u003c',
    '>': '\\u003e',
    '&': '\\u0026',
    '\u2028': '\\u2028',
    '\u2029': '\\u2029',
  })[char]);
}

/** Картинки истории → data:image/…, чтобы файл был совсем один. */
async function inlineAssets(story, base) {
  const cache = new Map();
  const inline = async (value) => {
    if (!value || typeof value !== 'string') return value;
    if (/^(data:|https?:|\/)/.test(value)) return value;
    const file = await resolveContainedFile(base, value);
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
  return story;
}

/** Вселенная для одного файла: обложка внутри, новеллы с data: картинками. */
async function inlineUniverse({ dir, universe, novels }) {
  const base = `stories/${dir}/`;
  const cover = await inlineAssets({ cover: universe.cover || '' }, base);
  return {
    ...universe,
    cover: cover.cover,
    baseUrl: '',
    novels: await Promise.all(novels.map(async ({ dir: novelDir, story }) => {
      const inlined = await inlineAssets(structuredClone(story), `${base}novels/${novelDir}/`);
      inlined.universe = universe.id;
      inlined._builtin = `${dir}/novels/${novelDir}`;
      return inlined;
    })),
  };
}

/** Один самодостаточный HTML: стили внутри, картинки в data:, никаких запросов. */
export async function buildStandalone(scan) {
  scan = scan || await scanStories();
  const [bundle, html] = await Promise.all([
    buildBundle(),
    fs.readFile(path.join(ROOT, 'index.html'), 'utf8'),
  ]);

  const cssFiles = ['css/base.css', 'css/player.css', 'css/editor.css'];
  const css = (await Promise.all(cssFiles.map((file) => fs.readFile(path.join(ROOT, file), 'utf8')))).join('\n');

  const universes = [];
  for (const item of scan) universes.push(await inlineUniverse(item));

  const watchdog = `window.__vnmyBoot = setTimeout(function () {
  if (window.__VNMY_BOOTED) return;
  var fallback = document.getElementById('boot-fallback');
  if (fallback) fallback.hidden = false;
}, 1500);`;

  const builtin = `window.__VNMY_BUILTIN_LIBRARY__ = ${jsonForInlineScript({ schema: 2, universes })};`;

  return html
    .replace(/\n\s*<link rel="preload"[^>]*>/, '')
    .replace(/\n\s*<link rel="manifest"[^>]*>/, '')
    .replace(/\n\s*<link rel="stylesheet"[^>]*>/g, '')
    .replace('</head>', () => `<style>\n${css}\n</style>\n</head>`)
    .replace(/<script>\s*\/\/ Если приложение не поднялось[\s\S]*?<\/script>/, () =>
      `<script>${inlineScript(watchdog)}</script>\n<script>${inlineScript(builtin)}</script>\n<script>${inlineScript(bundle)}</script>`)
    .replace('<!doctype html>', '<!doctype html>\n<!-- VNMY 2.0 — один файл: движок, стили, вселенные и картинки внутри. Сборка: npm run build -->');
}

async function main() {
  const scan = await scanStories();
  const [bundle, builtin, standalone, manifest] = await Promise.all([
    buildBundle(),
    buildBuiltinStories(scan),
    buildStandalone(scan),
    buildManifest(scan),
  ]);
  await fs.writeFile(path.join(ROOT, 'bundle.js'), bundle);
  await fs.writeFile(path.join(STORIES, 'builtin.js'), builtin);
  await fs.writeFile(path.join(STORIES, 'index.json'), manifest);
  await fs.writeFile(path.join(ROOT, 'vnmy.html'), standalone);
  const kb = (s) => `${Math.round(Buffer.byteLength(s) / 1024)} КБ`;
  const novels = scan.reduce((n, u) => n + u.novels.length, 0);
  console.log(`вселенных: ${scan.length}, новелл: ${novels}`);
  console.log(`stories/index.json — ${kb(manifest)}, bundle.js — ${kb(bundle)}, stories/builtin.js — ${kb(builtin)}, vnmy.html — ${kb(standalone)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
