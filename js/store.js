/* VNMY — хранилище: localStorage, библиотека историй, сохранения, импорт/экспорт */
import { normalizeStory, resolveUrl } from './format.js';
import { normalizeUniverse, createUniverse, universeData, looseUniverse, NO_UNIVERSE_TITLE } from './universe.js';
import { AUDIO_DEFAULTS } from './audio.js';
import { uid, download, readFileAsText, deepClone, prefersReducedMotion, clampSpriteScale } from './util.js';

import {
  initializeStorage, getLargeRecord, putLargeRecord, removeLargeRecord, flushStorage, storageBackend,
  largeStorageSize, largeRecordKeys, canStoreAssets, replaceStoryAssets, removeStoryAssets,
} from './persistence.js';
import { isZip, readZip } from './zip.js';
export { initializeStorage, flushStorage, storageBackend };

const K = {
  index: 'vnmy:index',
  story: (id) => `vnmy:story:${id}`,
  saves: (id) => `vnmy:saves:${id}`,
  universes: 'vnmy:universes',
  settings: 'vnmy:settings',
  seen: (id) => `vnmy:seen:${id}`,
  artwork: (id) => `vnmy:artwork:${id}`,
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

let builtinRequest = null;

/** Вселенные, которые едут вместе с движком. Загружаются один раз за запуск. */
export function loadBuiltinUniverses({ reload = false } = {}) {
  if (reload || !builtinRequest) {
    builtinRequest = readBuiltinUniverses().catch((err) => {
      builtinRequest = null;
      throw err;
    });
  }
  return builtinRequest;
}

async function readBuiltinUniverses() {
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
  removeStoryAssets(id);
  lsSet(K.index, JSON.stringify(listLocalStoryIds().filter((x) => x !== id)));
  lsRemove(K.saves(id));
  lsRemove(K.seen(id));
  lsRemove(K.artwork(id));
}

/**
 * История из JSON. Как и у .vnmy, id сохраняется: повторный импорт обновляет
 * новеллу, а её сохранения остаются. Картинки такой истории лежат прямо в
 * JSON, поэтому прежние картинки пакета с тем же id больше не нужны.
 */
export function importStoryJSON(json) {
  const raw = typeof json === 'string' ? JSON.parse(json) : deepClone(json);
  const story = normalizeStory(raw);
  if (!raw?.id) story.id = uid('story');
  story.readOnly = false;
  delete story.packaged;
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
  for (const track of story.soundtrack || []) if (track.src) urls.add(track.src);
  for (const scene of story.scenes) {
    if (scene.bg) urls.add(scene.bg);
    if (scene.music) urls.add(scene.music);
    for (const step of scene.steps) for (const key of ['bg', 'music', 'sound', 'voice']) if (step[key]) urls.add(step[key]);
  }
  for (const char of story.characters) {
    for (const url of Object.values(char.sprites || {})) if (url) urls.add(url);
  }
  return [...urls];
}

function replaceAssetPaths(story, map) {
  const swap = (url) => (url && map.has(url) ? map.get(url) : url);
  if (story.cover) story.cover = swap(story.cover);
  for (const track of story.soundtrack || []) track.src = swap(track.src);
  for (const scene of story.scenes) {
    scene.bg = swap(scene.bg);
    if (scene.music) scene.music = swap(scene.music);
    for (const step of scene.steps) for (const key of ['bg', 'music', 'sound', 'voice']) if (step[key]) step[key] = swap(step[key]);
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
    const absolute = resolveUrl(story, url);
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
    if (key === K.settings || key?.startsWith('vnmy:saves:') || key?.startsWith('vnmy:seen:') || key?.startsWith('vnmy:artwork:')) {
      const value = lsJSON(key, null);
      if (value != null) data[key] = value;
    }
  }
  return data;
}

function restoreBrowserBackup(data, idMap) {
  for (const [key, value] of Object.entries(data || {})) {
    if (key === K.settings && value && typeof value === 'object') lsSet(key, JSON.stringify(value));
    else if (/^vnmy:(saves|seen|artwork):.+/.test(key)) {
      const prefix = key.slice(0, key.indexOf(':', 5) + 1);
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
      removeStoryAssets(story.id);
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
  if (await isZip(file)) return importPackage(await readZip(file));
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
  const root = base || 'world';
  let id = root;
  let n = 2;
  while (taken.has(id)) id = `${root}-${n++}`;
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

/** Синхронный доступ к последней загруженной библиотеке. */
export function universeCatalog() {
  return libraryCache?.universes || [];
}

export function findUniverse(id) {
  return universeCatalog().find((u) => u.id === id) || null;
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
  return { slots: Array.isArray(value?.slots) ? value.slots.filter(Boolean) : [], auto: value?.auto && typeof value.auto === 'object' ? value.auto : null, quick: value?.quick && typeof value.quick === 'object' ? value.quick : null };
}

export function writeSave(storyId, slot, payload) {
  const saves = getSaves(storyId);
  const entry = { ...payload, at: Date.now() };
  if (slot === 'quick') {
    saves.quick = entry;
  } else if (slot === 'auto') {
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
  if (slot === 'quick') saves.quick = null;
  else if (slot === 'auto') saves.auto = null;
  else saves.slots = saves.slots.filter((entry) => entry.slot !== slot);
  lsSet(K.saves(storyId), JSON.stringify(saves));
  return saves;
}

export function clearSaves(storyId) {
  lsRemove(K.saves(storyId));
  lsRemove(K.seen(storyId));
  lsRemove(K.artwork(storyId));
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

export function getArtwork(storyId, kind = 'image') {
  const value = lsJSON(K.artwork(storyId), []);
  return Array.isArray(value) ? value.filter(item => item && typeof item.path === 'string' && (kind === null || (item.kind || 'image') === kind)) : [];
}

export function markArtwork(storyId, path, name, kind = 'image') {
  if (!path) return;
  const images = getArtwork(storyId, null);
  if (images.some(item => item.path === path && (item.kind || 'image') === kind)) return;
  lsSet(K.artwork(storyId), JSON.stringify([...images, { path, name: name || 'Сцена', ...(kind !== 'image' ? { kind } : {}) }]));
}

/** Настройки читателя по умолчанию. reduceMotion здесь нет: без явного
 *  выбора он повторяет системную настройку «уменьшить движение». */
export const DEFAULT_SETTINGS = Object.freeze({
  ...AUDIO_DEFAULTS, confirmSkip: true, vibration: false, textSpeed: 22, fontSize: 1, spriteScale: 1,
  dialogueOpacity: 0.9, instantText: false, skipSeen: false, keepAwake: true, autoDelay: 55,
});

export function getSettings() {
  const settings = { ...DEFAULT_SETTINGS, ...lsJSON(K.settings, {}) };
  settings.spriteScale = clampSpriteScale(settings.spriteScale);
  // «меньше анимации» по умолчанию повторяет системную настройку
  if (typeof settings.reduceMotion !== 'boolean') settings.reduceMotion = prefersReducedMotion();
  return settings;
}

/** Сбросить все настройки к исходным, включая системный выбор анимации. */
export function resetSettings() {
  lsRemove(K.settings);
  return getSettings();
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  next.spriteScale = clampSpriteScale(next.spriteScale);
  lsSet(K.settings, JSON.stringify(next));
  return next;
}

/* ─────────────────────────── прогресс чтения для библиотеки ─────────────────────────── */

/**
 * Самое свежее сохранение (авто, ручное или быстрое) — с него «Продолжить»
 * открывает игру. Библиотека показывает прогресс по нему же.
 */
export function latestSave(storyId) {
  const saves = getSaves(storyId);
  const all = [saves.auto, saves.quick, ...saves.slots].filter(Boolean);
  return all.sort((a, b) => (b.at || 0) - (a.at || 0))[0] || null;
}

export function progressOf(storyId) {
  return latestSave(storyId);
}

export function slugify(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[а-яё]/g, (c) => ({ ё: 'e', ж: 'zh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ю: 'yu', я: 'ya' }[c] || c))
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/* ─────────────────────────── файл новеллы .vnmy ───────────────────────────
 * Это zip той же папки, что лежала бы в stories/:
 *   universe.json + novels/<новелла>/story.json + assets/…   — вселенная;
 *   story.json + assets/…                                    — одна новелла.
 * id новеллы сохраняется: повторный импорт обновляет её, сохранения остаются.
 */
async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function readJSONBlob(blob) {
  try { return JSON.parse(await blob.text()); } catch { throw new Error('BAD_JSON'); }
}

const hiddenPart = (part) => part.startsWith('_') || part.startsWith('.');

/**
 * Раскладка пакета: корень (папка с universe.json или story.json, ближайшая
 * к началу архива) и папки новелл относительно корня. Общая для
 * предпросмотра импорта и самого импорта.
 */
export function packageLayout(files) {
  const markers = [...files.keys()]
    .filter((p) => /(^|\/)(universe|story)\.json$/.test(p) && !p.split('/').some(hiddenPart))
    .sort((a, b) => a.split('/').length - b.split('/').length);
  if (!markers.length) throw new Error('BAD_PACKAGE');
  const root = markers[0].replace(/[^/]*$/, '');
  const hasUniverse = files.has(`${root}universe.json`);
  const novelDirs = [];
  if (hasUniverse) {
    const prefix = `${root}novels/`;
    for (const p of files.keys()) {
      if (!p.startsWith(prefix)) continue;
      const parts = p.slice(prefix.length).split('/');
      if (parts.length === 2 && parts[1] === 'story.json' && !hiddenPart(parts[0])) novelDirs.push(`novels/${parts[0]}/`);
    }
    novelDirs.sort();
  } else {
    novelDirs.push('');
  }
  if (!novelDirs.length) throw new Error('BAD_PACKAGE');
  return { root, hasUniverse, novelDirs };
}

export async function importPackage(files) {
  const { root, hasUniverse, novelDirs } = packageLayout(files);
  const at = (rel) => files.get(root + rel);

  // Сначала читаем и проверяем всё содержимое пакета и только потом пишем:
  // битая вторая новелла не оставит в библиотеке половину пакета.
  const rawUniverse = hasUniverse ? await readJSONBlob(at('universe.json')) : null;
  const prepared = [];
  const missing = [];
  for (const dir of novelDirs) {
    const raw = await readJSONBlob(at(`${dir}story.json`));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.scenes) || !raw.scenes.length) throw new Error('BAD_PACKAGE');
    const story = normalizeStory(raw);
    story.readOnly = false;
    story.baseUrl = '';
    story.updatedAt = Date.now();
    const assets = new Map();
    for (const url of storyAssets(story)) {
      if (/^(data:|blob:|https?:|\/)/i.test(url)) continue;
      const blob = at(dir + url);
      if (blob) assets.set(url, blob); else missing.push(`${dir}${url}`);
    }
    prepared.push({ story, assets });
  }

  // вселенная: из universe.json пакета, иначе по полю universe новеллы
  let universe = null;
  const universeId = String(rawUniverse?.id || prepared[0].story.universe || '').trim();
  if (universeId) {
    const known = universeCatalog().find((u) => u.id === universeId) || loadLocalUniverse(universeId);
    const data = rawUniverse ? universeData(normalizeUniverse({ ...rawUniverse, id: universeId })) : null;
    if (data?.cover && at(data.cover)) data.cover = await blobToDataUrl(at(data.cover));
    else if (data && data.cover && !/^(data:|https?:)/.test(data.cover)) data.cover = '';
    if (known && (known.builtin || known.readOnly)) universe = known;
    else if (known) universe = data ? saveUniverse({ ...known, ...data, id: known.id, createdAt: known.createdAt }) : known;
    else universe = saveUniverse(createUniverse({ ...(data || { title: universeId }), id: universeId }));
  }

  const imported = [];
  for (const { story, assets } of prepared) {
    story.universe = universe?.id || '';
    const existed = listLocalStoryIds().includes(story.id);
    if (canStoreAssets()) {
      story.packaged = true;
      await replaceStoryAssets(story.id, assets);
    } else {
      // без IndexedDB вшиваем картинки прямо в историю (может не хватить места)
      const map = new Map();
      for (const [url, blob] of assets) map.set(url, await blobToDataUrl(blob));
      replaceAssetPaths(story, map);
    }
    try {
      saveStory(story, { touch: false });
    } catch (err) {
      // картинки новой новеллы без её сценария не нужны
      if (!existed) removeStoryAssets(story.id);
      if (String(err?.message) === 'STORAGE_FULL') err.imported = imported;
      throw err;
    }
    imported.push(story);
  }
  libraryCache = null;
  await flushStorage();
  if (missing.length) console.warn('[vnmy] в пакете нет картинок:', missing);
  const result = Object.assign(imported, { missing });
  if (rawUniverse && universe) result.universe = universe;
  return result;
}
