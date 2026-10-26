/* VNMY — хранилище: localStorage, библиотека историй, сохранения, импорт/экспорт */
import { normalizeStory, createStory, findScene, bareId, globalId } from './format.js';
import { uid, download, readFileAsText, deepClone } from './util.js';

const K = {
  index: 'vnmy:index',
  story: (id) => `vnmy:story:${id}`,
  saves: (id) => `vnmy:saves:${id}`,
  settings: 'vnmy:settings',
  seen: (id) => `vnmy:seen:${id}`,
};

const memory = new Map();

function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return memory.get(key) ?? null; }
}
function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    if (err && (err.name === 'QuotaExceededError' || err.code === 22)) {
      throw new Error('STORAGE_FULL');
    }
    memory.set(key, value);
  }
}
function lsRemove(key) {
  try { localStorage.removeItem(key); } catch { memory.delete(key); }
}
function lsJSON(key, fallback) {
  const raw = lsGet(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

/* ─────────────────────────── builtin истории ─────────────────────────── */

const builtinCache = new Map();

/**
 * Встроенные истории из папки /stories:
 * stories/index.json → stories/<name>/story.json.
 * Требуется http(s) — поэтому index.html открывают через сервер или хостинг.
 */
export async function loadBuiltinStories() {
  let names = [];
  try {
    const res = await fetch('stories/index.json', { cache: 'no-cache' });
    if (res.ok) {
      const data = await res.json();
      names = Array.isArray(data) ? data : data.stories || [];
    }
  } catch (err) {
    console.warn('[vnmy] не удалось прочитать stories/index.json', err);
  }
  if (!names.length) names = ['demo'];

  const stories = [];
  for (const name of names) {
    if (builtinCache.has(name)) { stories.push(builtinCache.get(name)); continue; }
    try {
      const res = await fetch(`stories/${name}/story.json`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(String(res.status));
      const raw = await res.json();
      raw.baseUrl = `stories/${name}/`;
      raw._builtin = name;
      const story = normalizeStory(raw);
      story.readOnly = true;
      builtinCache.set(name, story);
      stories.push(story);
    } catch (err) {
      console.warn(`[vnmy] не удалось загрузить историю «${name}»`, err);
    }
  }
  return stories;
}

export function hasBuiltin(name) {
  return builtinCache.has(name);
}

/* ─────────────────────────── локальные истории ─────────────────────────── */

export function listLocalStoryIds() {
  return lsJSON(K.index, []);
}

export function loadLocalStory(id) {
  const data = lsJSON(K.story(id), null);
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
  lsSet(K.story(story.id), JSON.stringify(data));
  const index = listLocalStoryIds();
  if (!index.includes(story.id)) {
    index.unshift(story.id);
    lsSet(K.index, JSON.stringify(index));
  }
  return story;
}

export function deleteStory(id) {
  lsRemove(K.story(id));
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
  // пока папка stories на месте; иначе импортируем ассеты как data URL (см. editor.exportAssetsTo).
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

export async function importStoryFile(file) {
  const text = await readFileAsText(file);
  return importStoryJSON(text);
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

/* ─────────────────────────── сохранения прохождения ─────────────────────────── */

export function getSaves(storyId) {
  return lsJSON(K.saves(storyId), { slots: [], auto: null });
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

export function clearSaves(storyId) {
  lsRemove(K.saves(storyId));
  lsRemove(K.seen(storyId));
}

/* ─────────────────────────── настройки и «прочитано» ─────────────────────────── */

export function getSeen(storyId) {
  return new Set(lsJSON(K.seen(storyId), []));
}

export function markSeen(storyId, stepId) {
  const seen = getSeen(storyId);
  if (seen.has(stepId)) return;
  seen.add(stepId);
  lsSet(K.seen(storyId), JSON.stringify([...seen]));
}

const DEFAULT_SETTINGS = { textSpeed: 22, fontSize: 1, skipSeen: false, keepAwake: true };

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...lsJSON(K.settings, {}) };
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
export const storageKeys = K;
