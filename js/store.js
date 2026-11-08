/* VNMY — хранилище: localStorage, библиотека историй, сохранения, импорт/экспорт */
import { normalizeStory, createStory, findScene, bareId, globalId } from './format.js';
import { normalizeUniverse, createUniverse, universeData, looseUniverse, NO_UNIVERSE_TITLE } from './universe.js';
import { uid, download, readFileAsText, deepClone, prefersReducedMotion } from './util.js';

import { initializeStorage, getLargeRecord, putLargeRecord, removeLargeRecord, flushStorage, storageBackend, largeStorageSize, largeRecordKeys } from './persistence.js';
export { initializeStorage, flushStorage, storageBackend };

const K = {
  index: 'vnmy:index',
  story: (id) => `vnmy:story:${id}`,
  saves: (id) => `vnmy:saves:${id}`,
  universes: 'vnmy:universes',
  settings: 'vnmy:settings',
  seen: (id) => `vnmy:seen:${id}`,
};

const memory = new Map();

function lsGet(key) {
  if (memory.has(key)) return memory.get(key);
  try { return localStorage.getItem(key); } catch { return memory.get(key) ?? null; }
}
function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
    memory.delete(key);
  } catch (err) {
    if (err && (err.name === 'QuotaExceededError' || err.code === 22)) {
      throw new Error('STORAGE_FULL');
    }
    memory.set(key, value);
  }
}
function lsRemove(key) {
  memory.delete(key);
  try { localStorage.removeItem(key); } catch { /* memory already removed */ }
}
function lsJSON(key, fallback) {
  const raw = lsGet(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

/* ─────────────────── встроенные вселенные и новеллы ─────────────────── */

const builtinCache = new Map();

/**
 * Встроенная библиотека — то, что едет вместе с движком:
 *  - при обычном запуске: stories/index.json (манифест, его пишет npm run build)
 *    → stories/<вселенная>/universe.json → stories/<вселенная>/novels/<новелла>/story.json;
 *  - при открытии с диска и в vnmy.html: window.__VNMY_BUILTIN_LIBRARY__ из сборки.
 */
function embeddedLibrary() {
  const lib = window.__VNMY_BUILTIN_LIBRARY__;
  if (lib && Array.isArray(lib.universes) && lib.universes.length) return lib;
  const stories = Array.isArray(window.__VNMY_BUILTIN_STORIES__) ? window.__VNMY_BUILTIN_STORIES__ : null;
  if (!stories?.length) return null;
  // старая сборка без вселенных: раскладываем новеллы по их полю universe
  const groups = new Map();
  for (const raw of stories) {
    const id = String(raw.universe || '');
    if (!groups.has(id)) groups.set(id, { id, title: id || NO_UNIVERSE_TITLE, novels: [] });
    groups.get(id).novels.push(raw);
  }
  return { schema: 2, universes: [...groups.values()] };
}

function normalizeBuiltinStory(raw, { baseUrl, universeId }) {
  const key = raw._builtin || `${universeId || 'none'}/${raw.id || 'story'}`;
  if (builtinCache.has(key)) return builtinCache.get(key);
  const copy = deepClone(raw);
  copy.baseUrl = copy.baseUrl || baseUrl || '';
  copy.universe = universeId;
  const story = normalizeStory(copy);
  story.readOnly = true;
  story.universe = universeId;
  builtinCache.set(key, story);
  return story;
}

function builtinFromEmbedded(lib) {
  const assets = new Map(Object.entries(lib.assets || {}));
  const universes = [];
  for (const raw of lib.universes) {
    const universe = normalizeUniverse({ ...raw, baseUrl: '', builtin: true, readOnly: true });
    universe.novels = (raw.novels || []).map((novel) =>
      normalizeBuiltinStory(assets.size ? replaceAssetPaths(deepClone(novel), assets) : novel, { baseUrl: '', universeId: universe.id }));
    universes.push(universe);
  }
  return universes;
}

async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

// Пустой каталог — нормальное состояние (в поставке может не быть историй).
// Ошибкой считается только недоступная библиотека: её и показываем в подписи.
let builtinBroken = false;

/** true — встроенные вселенные не удалось прочитать (пустой каталог ошибкой не считается). */
export function builtinIsBroken() {
  return builtinBroken;
}

/** Вселенные, которые едут вместе с движком. */
export async function loadBuiltinUniverses() {
  builtinBroken = false;
  const embedded = embeddedLibrary();
  if (location.protocol === 'file:') {
    // с диска сети нет: только вшитая сборка
    if (embedded) return builtinFromEmbedded(embedded);
    console.warn('[vnmy] нет встроенной библиотеки — соберите файлы командой npm run build');
    builtinBroken = true;
    return [];
  }

  let manifest = null;
  try {
    manifest = await fetchJSON('stories/index.json');
  } catch (err) {
    console.warn('[vnmy] не удалось прочитать stories/index.json', err);
  }

  const entries = Array.isArray(manifest) ? null : manifest?.universes;
  if (!Array.isArray(entries)) {
    // сборка «один файл» (папки stories рядом нет) или старый манифест-список
    if (embedded) return builtinFromEmbedded(embedded);
    if (Array.isArray(manifest)) return legacyUniverses(manifest);
    builtinBroken = true;
    return [];
  }

  const universes = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const dir = String(entry.dir || entry.id || '').replace(/^\/+|\/+$/g, '');
    if (!dir) continue;
    const universe = normalizeUniverse({ ...entry, id: entry.id || dir });
    universe.baseUrl = `stories/${dir}/`;
    universe.builtin = true;
    universe.readOnly = true;
    universe.novels = [];
    for (const novel of entry.novels || []) {
      const novelDir = String(novel?.dir || novel?.id || '');
      if (!novelDir) continue;
      try {
        const raw = await fetchJSON(`stories/${dir}/novels/${novelDir}/story.json`);
        raw._builtin = `${dir}/novels/${novelDir}`;
        universe.novels.push(normalizeBuiltinStory(raw, {
          baseUrl: `stories/${dir}/novels/${novelDir}/`,
          universeId: universe.id,
        }));
      } catch (err) {
        console.warn(`[vnmy] не удалось загрузить новеллу «${dir}/${novelDir}»`, err);
      }
    }
    universes.push(universe);
  }
  if (!universes.length && embedded) return builtinFromEmbedded(embedded);
  return universes;
}

/** Старый манифест: просто список папок с историями (до появления вселенных). */
async function legacyUniverses(names) {
  const novels = [];
  for (const name of names) {
    try {
      const raw = await fetchJSON(`stories/${name}/story.json`);
      raw._builtin = name;
      novels.push(normalizeBuiltinStory(raw, { baseUrl: `stories/${name}/`, universeId: '' }));
    } catch (err) {
      console.warn(`[vnmy] не удалось загрузить историю «${name}»`, err);
    }
  }
  return novels.length ? [looseUniverse(novels)] : [];
}

/* ─────────────────────────── локальные истории ─────────────────────────── */

export function listLocalStoryIds() {
  const index = lsJSON(K.index, []);
  return [...new Set([...(Array.isArray(index) ? index : []), ...largeRecordKeys().filter(k => k.startsWith('vnmy:story:')).map(k => k.slice('vnmy:story:'.length))])];
}

export function loadLocalStory(id) {
  const data = getLargeRecord(K.story(id), () => lsJSON(K.story(id), null));
  if (!data) return null;
  const story = normalizeStory(data);
  story.readOnly = false;
  return story;
}

export function listLocalStories() {
  return listLocalStoryIds().map(loadLocalStory).filter(Boolean);
}

export function saveStory(story, { touch = true } = {}) {
  if (story.readOnly) throw new Error('Встроенную историю нельзя сохранить: сначала сделайте копию');
  if (touch) story.updatedAt = Date.now();
  const data = deepClone(story);
  delete data.readOnly;
  putLargeRecord(K.story(story.id), data, () => lsSet(K.story(story.id), JSON.stringify(data)));
  const index = listLocalStoryIds();
  if (!index.includes(story.id)) {
    index.unshift(story.id);
    lsSet(K.index, JSON.stringify(index));
  }
  return story;
}

export function deleteStory(id) {
  removeLargeRecord(K.story(id), () => lsRemove(K.story(id)));
  lsSet(K.index, JSON.stringify(listLocalStoryIds().filter((x) => x !== id)));
  lsRemove(K.saves(id));
  lsRemove(K.seen(id));
}

export function duplicateStory(story, titleSuffix = ' (копия)') {
  const copy = deepClone(story);
  copy.id = uid('story');
  copy.title = story.title + titleSuffix;
  copy.readOnly = false;
  copy.createdAt = Date.now();
  copy.updatedAt = Date.now();
  copy.baseUrl = story.baseUrl || '';
  // встроенная история ссылается на файлы — при копировании пути остаются рабочими,
  // пока папка stories на месте; иначе импортируем ассеты как data URL.
  return saveStory(copy, { touch: false });
}

export function importStoryJSON(json, { keepId = false } = {}) {
  const story = normalizeStory(typeof json === 'string' ? JSON.parse(json) : deepClone(json));
  if (!keepId || listLocalStoryIds().includes(story.id)) story.id = uid('story');
  story.readOnly = false;
  story.title = story.title || 'Импортированная история';
  // у импортированной истории относительные пути некуда не ведут
  if (story.baseUrl && story.baseUrl.startsWith('stories/')) story.baseUrl = '';
  story.updatedAt = Date.now();
  return story;
}

/** Все картинки истории в одном месте: путь → как он записан. */
export function storyAssets(story) {
  const urls = new Set();
  if (story.cover) urls.add(story.cover);
  for (const m of story.media || []) if (m.url) urls.add(m.url);
  for (const scene of story.scenes) {
    if (scene.bg) urls.add(scene.bg);
    for (const step of scene.steps) if (step.bg) urls.add(step.bg);
  }
  for (const char of story.characters) {
    for (const url of Object.values(char.sprites || {})) if (url) urls.add(url);
  }
  return [...urls];
}

function replaceAssetPaths(story, map) {
  const swap = (url) => (url && map.has(url) ? map.get(url) : url);
  if (story.cover) story.cover = swap(story.cover);
  for (const m of story.media || []) m.url = swap(m.url);
  for (const scene of story.scenes) {
    scene.bg = swap(scene.bg);
    for (const step of scene.steps) if (step.bg) step.bg = swap(step.bg);
  }
  for (const char of story.characters) {
    for (const key of Object.keys(char.sprites || {})) char.sprites[key] = swap(char.sprites[key]);
  }
  return story;
}

async function toDataUrl(url) {
  if (!url || /^data:/i.test(url)) return url;
  try {
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** История со вшитыми картинками: файл открывается без папки stories. */
async function portableStory(story, { limitMb = 24, used = 0 } = {}) {
  const data = deepClone(story);
  delete data.readOnly;
  const map = new Map();
  const budget = limitMb * 1024 * 1024;
  let spent = used;
  let skipped = 0;

  for (const url of storyAssets(data)) {
    if (/^data:/i.test(url)) { spent += url.length; continue; }
    if (url.startsWith('http') && !data.baseUrl) {
      // внешние ссылки оставляем как есть
      continue;
    }
    const absolute = /^https?:|^\//.test(url) ? url : (data.baseUrl || '') + url;
    if (spent > budget) { skipped++; continue; }
    const dataUrl = await toDataUrl(absolute);
    if (dataUrl) {
      map.set(url, dataUrl);
      spent += dataUrl.length;
    } else {
      skipped++;
    }
  }

  replaceAssetPaths(data, map);
  data.baseUrl = '';
  data.exportedAt = Date.now();
  data.portable = true;
  return { data, images: map.size, skipped, spent };
}

/**
 * Портируемый экспорт одной новеллы: все картинки вшиваются в JSON как data URL.
 * limitMb ограничивает суммарный размер картинок (по умолчанию 24 МБ).
 */
export async function exportStoryPortable(story, { limitMb = 24 } = {}) {
  const { data, images, skipped } = await portableStory(story, { limitMb });
  const json = JSON.stringify(data, null, 2);
  const slug = slugify(story.title) || 'story';
  download(`${slug}.json`, json);
  return { bytes: json.length, images, skipped };
}

/**
 * Экспорт вселенной вместе со всеми её новеллами:
 * один JSON, картинки внутри, импортируется на другом устройстве целиком.
 */
export async function exportUniversePortable(universe, novels, { limitMb = 64 } = {}) {
  const payload = {
    format: 'vnmy-universe',
    version: 1,
    exportedAt: Date.now(),
    universe: universeData(universe),
    novels: [],
  };
  let images = 0;
  let skipped = 0;
  let spent = 0;
  for (const story of novels) {
    const result = await portableStory(story, { limitMb, used: spent });
    spent = result.spent;
    images += result.images;
    skipped += result.skipped;
    payload.novels.push({ ...result.data, universe: universe.id });
  }
  const json = JSON.stringify(payload, null, 2);
  download(`${slugify(universe.title) || 'universe'}-universe.json`, json);
  return { bytes: json.length, images, skipped, novels: payload.novels.length };
}

/** Экспорт всех локальных историй одним файлом — бэкап браузера. */
export async function exportBackup() {
  const stories = [];
  for (const story of listLocalStories()) {
    const { data, skipped } = await portableStory(story, { limitMb: Infinity });
    if (skipped) throw new Error('BACKUP_ASSETS_MISSING');
    stories.push(data);
  }
  const payload = {
    format: 'vnmy-backup',
    version: 3,
    exportedAt: Date.now(),
    universes: listLocalUniverses(),
    stories,
    browser: browserBackupData(),
  };
  const stamp = new Date().toISOString().slice(0, 10);
  download(`vnmy-backup-${stamp}.json`, JSON.stringify(payload));
  return stories.length;
}

/** Small records include built-in progress, seen markers, and preferences. */
export function browserBackupData() {
  const data = {};
  const keys = new Set(memory.keys());
  try { for (let i = 0; i < localStorage.length; i++) keys.add(localStorage.key(i)); } catch { /* memory fallback */ }
  for (const key of keys) {
    if (key === K.settings || key?.startsWith('vnmy:saves:') || key?.startsWith('vnmy:seen:')) {
      const value = lsJSON(key, null);
      if (value != null) data[key] = value;
    }
  }
  return data;
}

function restoreBrowserBackup(data, idMap) {
  for (const [key, value] of Object.entries(data || {})) {
    if (key === K.settings && value && typeof value === 'object') lsSet(key, JSON.stringify(value));
    else if (/^vnmy:(saves|seen):.+/.test(key)) {
      const prefix = key.startsWith('vnmy:saves:') ? 'vnmy:saves:' : 'vnmy:seen:';
      const id = key.slice(prefix.length);
      lsSet(prefix + (idMap.get(id) || id), JSON.stringify(value));
    }
  }
}

/** Импорт набора новелл с защитой от переполнения места. */
function importStoryList(rawList, { universeId = null } = {}) {
  const imported = [];
  for (const raw of rawList) {
    const story = importStoryJSON(raw);
    if (universeId != null) story.universe = universeId;
    try {
      saveStory(story);
      imported.push(story);
    } catch (err) {
      if (String(err?.message) === 'STORAGE_FULL') {
        const error = new Error('STORAGE_FULL');
        error.imported = imported;
        throw error;
      }
      throw err;
    }
  }
  return imported;
}

/**
 * Импорт вселенной: universe + его новеллы.
 * Если такая вселенная уже есть (например, встроенная) — новеллы просто добавятся в неё.
 */
export function importUniverseBundle(parsed) {
  const rawUniverse = parsed?.universe || {};
  const known = universeCatalog().find((u) => u.id === rawUniverse.id);
  let universe;
  if (known && (known.builtin || known.readOnly)) {
    universe = known;
  } else if (known) {
    universe = saveUniverse({ ...known, ...universeData(normalizeUniverse(rawUniverse)), createdAt: known.createdAt });
  } else {
    universe = saveUniverse(createUniverse({ ...universeData(normalizeUniverse(rawUniverse)), id: uniqueUniverseId(rawUniverse.id) }));
  }
  const novels = importStoryList(parsed?.novels || [], { universeId: universe.id });
  libraryCache = null;
  return { universe, novels };
}

/**
 * Импорт файла: одна новелла, портируемая новелла, вселенная целиком
 * или бэкап браузера со списком.
 */
export async function importStoryFile(file) {
  const text = await readFileAsText(file);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('BAD_JSON');
  }

  if (parsed?.format === 'vnmy-universe') {
    const { universe, novels } = importUniverseBundle(parsed);
    // у массива есть .universe — библиотеке нужно имя, чтобы показать тост
    await flushStorage();
    return Object.assign(novels, { universe });
  }

  if (parsed?.format === 'vnmy-backup') {
    for (const raw of parsed.universes || []) {
      try { saveUniverse(createUniverse(raw)); } catch { /* бэкап важнее вселенной */ }
    }
    libraryCache = null;
    const source = parsed.stories || parsed.novels || [];
    const imported = importStoryList(source);
    const ids = new Map(source.map((raw, i) => [raw.id, imported[i]?.id]));
    restoreBrowserBackup(parsed.browser, ids);
    await flushStorage();
    return imported;
  }

  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.stories) ? parsed.stories : [parsed];
  const imported = importStoryList(list);
  await flushStorage();
  return imported;
}

export function exportStory(story) {
  const data = deepClone(story);
  data.readOnly = false;
  const slug = slugify(story.title) || 'story';
  download(`${slug}.json`, JSON.stringify(data, null, 2));
}

export function exportStoryData(story) {
  const data = deepClone(story);
  delete data.readOnly;
  return data;
}

/** Сколько места занято и сколько примерно осталось. */
export function storageUsage() {
  let used = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith('vnmy:')) continue;
      used += key.length + (localStorage.getItem(key)?.length || 0);
    }
  } catch { /* ignore */ }
  return { used: used + largeStorageSize(), limit: storageBackend() === 'IndexedDB' ? null : 5 * 1024 * 1024, backend: storageBackend() };
}

/* ─────────────────────── свои вселенные и вся библиотека ─────────────────────── */

/** Вселенные, созданные в браузере (лежат рядом со своими новеллами). */
export function listLocalUniverses() {
  return getLargeRecord(K.universes, () => lsJSON(K.universes, [])).filter(Boolean).map((u) => normalizeUniverse(u));
}

export function loadLocalUniverse(id) {
  return listLocalUniverses().find((u) => u.id === id) || null;
}

export function saveUniverse(universe, { touch = true } = {}) {
  const next = normalizeUniverse(universe);
  if (touch) next.updatedAt = Date.now();
  const list = listLocalUniverses().filter((u) => u.id !== next.id);
  list.push(universeData(next));
  putLargeRecord(K.universes, list, () => lsSet(K.universes, JSON.stringify(list)));
  libraryCache = null;
  return next;
}

/** Свободный id: не занят ни файлами, ни своими вселенными. */
export function uniqueUniverseId(base) {
  const taken = new Set([...universeCatalog().map((u) => u.id), ...listLocalUniverses().map((u) => u.id)]);
  let id = base || 'world';
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

/**
 * Удаление вселенной: новеллы остаются, но становятся «без вселенной».
 * Сами новеллы удаляются только вместе с историями (см. deleteStory).
 */
export function deleteUniverse(id) {
  const list = listLocalUniverses().filter(u => u.id !== id);
  putLargeRecord(K.universes, list, () => lsSet(K.universes, JSON.stringify(list)));
  for (const story of listLocalStories()) {
    if (story.universe !== id) continue;
    story.universe = '';
    saveStory(story, { touch: false });
  }
  libraryCache = null;
}

/** Перенести новеллу в другую вселенную ('' — без вселенной). */
export function moveStoryToUniverse(story, universeId) {
  story.universe = universeId || '';
  saveStory(story, { touch: false });
  libraryCache = null;
  return story;
}

let libraryCache = null;

/** Синхронный доступ к последней загруженной библиотеке (для редактора). */
export function universeCatalog() {
  return libraryCache?.universes || [];
}

export function findUniverse(id) {
  return universeCatalog().find((u) => u.id === id) || null;
}

/** Варианты для выпадающего списка в редакторе: «Без вселенной» + все известные. */
export function universeOptions(currentId = '') {
  const options = [{ value: '', label: NO_UNIVERSE_TITLE }];
  for (const universe of universeCatalog()) options.push({ value: universe.id, label: universe.title });
  if (currentId && !options.some((o) => o.value === currentId)) options.push({ value: currentId, label: currentId });
  return options;
}

/**
 * Библиотека целиком — вселенные с новеллами:
 * встроенные (файлы/сборка) + свои (localStorage) + «Без вселенной».
 */
export async function loadLibrary() {
  const [builtin, localUniverses, localStories] = [
    await loadBuiltinUniverses(),
    listLocalUniverses(),
    listLocalStories().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
  ];

  const universes = builtin.map((u) => ({ ...u, novels: [...u.novels] }));
  const byId = new Map(universes.map((u) => [u.id, u]));

  for (const own of localUniverses) {
    if (byId.has(own.id)) continue; // вселенная из файлов: свои новеллы просто добавятся
    universes.push({ ...own, novels: [] });
    byId.set(own.id, universes[universes.length - 1]);
  }

  const loose = [];
  for (const story of localStories) {
    const target = story.universe ? byId.get(story.universe) : null;
    if (target) target.novels.push(story);
    else loose.push(story);
  }
  if (loose.length) universes.push(looseUniverse(loose));

  universes.sort((a, b) => (a.order - b.order) || a.title.localeCompare(b.title, 'ru'));
  libraryCache = { universes };
  return libraryCache;
}

/* ─────────────────────────── сохранения прохождения ─────────────────────────── */

export function getSaves(storyId) {
  const value = lsJSON(K.saves(storyId), null);
  return { slots: Array.isArray(value?.slots) ? value.slots.filter(Boolean) : [], auto: value?.auto && typeof value.auto === 'object' ? value.auto : null };
}

export function writeSave(storyId, slot, payload) {
  const saves = getSaves(storyId);
  const entry = { ...payload, at: Date.now() };
  if (slot === 'auto') {
    saves.auto = entry;
  } else {
    saves.slots = saves.slots.filter((s) => s.slot !== slot);
    saves.slots.push({ slot, ...entry });
    saves.slots.sort((a, b) => b.at - a.at);
    saves.slots = saves.slots.slice(0, 6);
  }
  lsSet(K.saves(storyId), JSON.stringify(saves));
  return saves;
}

/** Удаляет один слот (автосейв не трогает). */
export function deleteSave(storyId, slot) {
  const saves = getSaves(storyId);
  if (slot === 'auto') saves.auto = null;
  else saves.slots = saves.slots.filter((entry) => entry.slot !== slot);
  lsSet(K.saves(storyId), JSON.stringify(saves));
  return saves;
}

export function clearSaves(storyId) {
  lsRemove(K.saves(storyId));
  lsRemove(K.seen(storyId));
}

/* ─────────────────────────── настройки и «прочитано» ─────────────────────────── */

export function getSeen(storyId) {
  const seen = lsJSON(K.seen(storyId), []);
  return new Set(Array.isArray(seen) ? seen : []);
}

export function markSeen(storyId, stepId) {
  const seen = getSeen(storyId);
  if (seen.has(stepId)) return;
  seen.add(stepId);
  lsSet(K.seen(storyId), JSON.stringify([...seen]));
}

const DEFAULT_SETTINGS = { textSpeed: 22, fontSize: 1, skipSeen: false, keepAwake: true };

export function getSettings() {
  const settings = { ...DEFAULT_SETTINGS, ...lsJSON(K.settings, {}) };
  // «меньше анимации» по умолчанию повторяет системную настройку
  if (typeof settings.reduceMotion !== 'boolean') settings.reduceMotion = prefersReducedMotion();
  return settings;
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  lsSet(K.settings, JSON.stringify(next));
  return next;
}

/* ─────────────────────────── прогресс чтения для библиотеки ─────────────────────────── */

export function progressOf(storyId) {
  const saves = getSaves(storyId);
  const save = saves.auto || saves.slots[0];
  if (!save) return null;
  return save;
}

export function slugify(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[а-яё]/g, (c) => ({ ё: 'e', ж: 'zh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ю: 'yu', я: 'ya' }[c] || c))
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Сохранить точку прохождения: сцена + шаг + накопленное состояние */
export function makeSavePoint(story, sceneId, stepIndex, extra = {}) {
  const scene = findScene(story, sceneId);
  return {
    sceneId,
    sceneIndex: story.scenes.findIndex((s) => s.id === sceneId),
    stepIndex,
    stepId: scene ? globalId(scene.id, scene.steps[stepIndex]?.id || '') : '',
    ...extra,
  };
}

export { createStory, normalizeStory, bareId, globalId };
