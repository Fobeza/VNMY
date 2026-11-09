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
import { createHash } from 'node:crypto';
import path from 'node:path';
import { validateStories } from './validate.mjs';

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
export async function scanStories(root = STORIES) {
  const universes = [];
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return universes;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || isTemplate(entry.name)) continue;
    const item = await scanUniverse(path.join(root, entry.name));
    if (item) universes.push(item);
  }

  universes.sort((a, b) => (Number(a.universe.order) || 100) - (Number(b.universe.order) || 100)
    || a.dir.localeCompare(b.dir));
  return universes;
}

/** Одна вселенная: папка с universe.json и novels/<новелла>/story.json. */
export async function scanUniverse(base) {
  const dir = path.basename(base);
  let universe;
  try {
    universe = await readJSON(await resolveContainedFile(base, 'universe.json', 'Universe'));
  } catch {
    console.warn(`[vnmy] пропускаю «${path.relative(ROOT, base) || base}»: нет universe.json`);
    return null;
  }
  universe.id = String(universe.id || dir);
  universe.title = String(universe.title || dir);
  let novelDirs = [];
  try {
    novelDirs = (await fs.readdir(path.join(base, 'novels'), { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !isTemplate(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    /* у вселенной пока нет новелл */
  }
  const novels = [];
  for (const novelDir of novelDirs) {
    const novelPath = path.join(base, 'novels', novelDir);
    try {
      novels.push({ dir: novelDir, path: novelPath, story: await readJSON(await resolveContainedFile(novelPath, 'story.json', 'Story')) });
    } catch (err) {
      throw new Error(`${novelPath}: ${err.message}`, { cause: err });
    }
  }
  return { dir, path: base, universe, novels };
}

/**
 * Папка, которую передали в check/pack: вселенная (universe.json),
 * одна новелла (story.json) или каталог со вселенными, как stories/.
 */
export async function scanSource(source) {
  const base = path.resolve(source);
  const has = async (name) => fs.access(path.join(base, name)).then(() => true, () => false);
  if (await has('universe.json')) return [await scanUniverse(base)].filter(Boolean);
  if (await has('story.json')) {
    const story = await readJSON(await resolveContainedFile(base, 'story.json', 'Story'));
    const id = String(story.universe || '');
    return [{ dir: id, path: base, single: true, universe: { id, title: id }, novels: [{ dir: path.basename(base), path: base, story }] }];
  }
  return scanStories(base);
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
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif',
};

function isWithinDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`));
}

export async function resolveContainedFile(base, value, kind = 'Asset') {
  const sourceDirectory = path.resolve(ROOT, base);
  const file = path.resolve(sourceDirectory, value);
  if (!isWithinDirectory(sourceDirectory, file)) {
    throw new Error(`${kind} path escapes its source directory: ${value}`);
  }

  // Lexical containment is not enough if a file or directory is a symlink.
  // Inside the repository the folder itself must not be a symlink either;
  // an external novel folder (npm run check -- <папка>) is taken as given.
  const realRoot = await fs.realpath(ROOT);
  const inRepo = isWithinDirectory(ROOT, sourceDirectory);
  const [realDirectory, realFile] = await Promise.all([
    fs.realpath(sourceDirectory),
    fs.realpath(file),
  ]);
  const expectedDirectory = inRepo ? path.resolve(realRoot, path.relative(ROOT, sourceDirectory)) : realDirectory;
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
async function inlineAssets(story, base, registry = null) {
  const cache = new Map();
  const inline = async (value, direct = false) => {
    if (!value || typeof value !== 'string') return value;
    if (/^(data:|https?:|\/)/.test(value)) return value;
    const file = await resolveContainedFile(base, value);
    if (!cache.has(file)) {
      const buffer = await fs.readFile(file);
      const ext = path.extname(file).slice(1).toLowerCase();
      cache.set(file, `data:${MIME[ext] || 'application/octet-stream'};base64,${buffer.toString('base64')}`);
    }
    const data = cache.get(file);
    if (!registry || direct) return data;
    const id = `asset:${createHash('sha256').update(data).digest('hex').slice(0, 24)}`;
    registry.set(id, data);
    return id;
  };

  story.cover = await inline(story.cover, true);
  for (const track of story.soundtrack || []) track.src = await inline(track.src);
  for (const item of story.media || []) item.url = await inline(item.url);
  for (const char of story.characters || []) {
    for (const key of Object.keys(char.sprites || {})) char.sprites[key] = await inline(char.sprites[key]);
  }
  for (const scene of story.scenes || []) {
    scene.bg = await inline(scene.bg);
    if (scene.music) scene.music = await inline(scene.music);
    for (const step of scene.steps || []) for (const key of ['music', 'sound', 'voice']) if (step[key]) step[key] = await inline(step[key]);
    for (const step of scene.steps || []) step.bg = await inline(step.bg);
  }
  story.baseUrl = '';
  return story;
}

/** Вселенная для одного файла: обложка внутри, новеллы с data: картинками. */
async function inlineUniverse({ dir, universe, novels }, registry) {
  const base = `stories/${dir}/`;
  const cover = await inlineAssets({ cover: universe.cover || '' }, base);
  return {
    ...universe,
    cover: cover.cover,
    baseUrl: '',
    novels: await Promise.all(novels.map(async ({ dir: novelDir, story }) => {
      const inlined = await inlineAssets(structuredClone(story), `${base}novels/${novelDir}/`, registry);
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

  const cssFiles = ['css/base.css', 'css/player.css'];
  const css = (await Promise.all(cssFiles.map((file) => fs.readFile(path.join(ROOT, file), 'utf8')))).join('\n');

  const universes = [];
  const registry = new Map();
  for (const item of scan) universes.push(await inlineUniverse(item, registry));

  const watchdog = `window.__vnmyBoot = setTimeout(function () {
  if (window.__VNMY_BOOTED) return;
  var fallback = document.getElementById('boot-fallback');
  if (fallback) fallback.hidden = false;
}, 1500);`;

  const builtin = `window.__VNMY_BUILTIN_LIBRARY__ = ${jsonForInlineScript({ schema: 2, universes, assets: Object.fromEntries([...registry].sort(([a], [b]) => a.localeCompare(b))) })};`;

  return html
    .replace(/\n\s*<link rel="preload"[^>]*>/, '')
    .replace(/\n\s*<link rel="manifest"[^>]*>/, '')
    .replace(/\n\s*<link rel="stylesheet"[^>]*>/g, '')
    .replace('</head>', () => `<style>\n${css}\n</style>\n</head>`)
    .replace(/<script>\s*\/\/ Если приложение не поднялось[\s\S]*?<\/script>/, () =>
      `<script>${inlineScript(watchdog)}</script>\n<script>${inlineScript(builtin)}</script>\n<script>${inlineScript(bundle)}</script>`)
    .replace('<!doctype html>', '<!doctype html>\n<!-- VNMY 2.2 — один файл: движок, стили и встроенная библиотека внутри. Сборка: npm run build -->');
}

async function main() {
  // По умолчанию собираем только движок: новеллы в репозиторий не попадают
  // и импортируются в приложении из файла .vnmy (npm run pack).
  // --with-stories встраивает папки из stories/ — для своей сборки, не для коммита.
  const withStories = process.argv.includes('--with-stories');
  const scan = withStories ? await scanStories() : [];
  if (withStories && scan.length) console.warn('[vnmy] сборка с новеллами из stories/ — не коммитьте vnmy.html и stories/*.js из неё');
  await validateStories(scan);
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
