/* VNMY — точка входа и переключение экранов.
 *
 * Экраны: вселенные → новеллы вселенной → игра / редактор.
 * currentUniverseId: null — открыт список вселенных; '' — «Без вселенной».
 */
import { renderLibrary, wireLibrary, markBuiltinWarning } from './library.js';
import { renderUniverse, wireUniverse } from './novels.js';
import { openPlayer, closePlayer } from './player.js';
import { openEditor, closeEditor } from './editor.js';
import { createStory, saveStory, loadBuiltinUniverses, initializeStorage } from './store.js';
import { $ } from './util.js';
import { toast } from './ui.js';

const SCREENS = ['library', 'universe', 'player', 'editor'];
let current = 'library';
let currentUniverseId = null;
let guardInstalled = false;

function show(name) {
  for (const id of SCREENS) {
    const node = $(`#screen-${id}`);
    if (node) node.hidden = id !== name;
  }
  document.body.dataset.screen = name;
  current = name;
  window.scrollTo({ top: 0 });
}

async function backToLibrary() {
  closePlayer();
  closeEditor({ silent: true });
  currentUniverseId = null;
  document.documentElement.lang = 'ru';
  document.documentElement.style.removeProperty('--accent');
  show('library');
  await renderLibrary(hooks);
}

async function openUniverseScreen(universeId) {
  closePlayer();
  closeEditor({ silent: true });
  currentUniverseId = universeId;
  show('universe');
  await renderUniverse(universeId, hooks);
  pushScreen('universe');
}

/** Назад: игра/редактор → вселенная, вселенная → список вселенных. */
async function goBack() {
  if (current === 'universe') return backToLibrary();
  if (currentUniverseId !== null) return openUniverseScreen(currentUniverseId);
  return backToLibrary();
}

function playStory(story, opts = {}) {
  currentUniverseId = story.universe || '';
  closeEditor({ silent: true });
  show('player');
  openPlayer(story, {
    ...opts,
    onExit: () => { goBack(); },
    onEdit: (target) => editStory(target),
  });
  pushScreen('player');
}

function editStory(story, opts = {}) {
  closePlayer();
  show('editor');
  openEditor(story, {
    ...opts,
    onExit: () => goBack(),
    onPlay: (target) => {
      saveStory(target);
      playStory(target, { fresh: true });
    },
  });
  pushScreen('editor');
}

const hooks = {
  onPlay: (story, opts) => playStory(story, opts),
  onEdit: (story, opts) => editStory(story, opts),
  onOpenUniverse: (universeId) => openUniverseScreen(universeId),
  onBack: () => goBack(),
  onNew: (universeId = '') => {
    const story = createStory({ title: 'Новая новелла', universe: universeId || '' });
    saveStory(story);
    editStory(story, { isNew: true });
    return story;
  },
};

function pushScreen(screen) {
  try {
    if (history.state?.vnmy !== screen) history.pushState({ vnmy: screen }, '', location.pathname + location.search);
  } catch { /* file:// может запрещать pushState */ }
}

function installHistoryGuard() {
  if (guardInstalled) return;
  guardInstalled = true;
  window.addEventListener('popstate', async () => {
    if (current === 'library') return;
    await goBack();
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!/^https?:$/.test(location.protocol)) return;
  // офлайн-режим не нужен в режиме разработки на localhost со сборочными инструментами,
  // но для игры с телефона он обязателен
  navigator.serviceWorker.register('sw.js').catch((err) => {
    console.warn('[vnmy] service worker не зарегистрирован', err);
  });
}

async function boot() {
  window.__VNMY_BOOTED = true;
  clearTimeout(window.__vnmyBoot);
  await initializeStorage();
  document.addEventListener('vnmy:storage-error', () => toast('Не удалось сохранить данные. Экспортируйте копию перед выходом.', 6000));
  registerServiceWorker();
  wireLibrary();
  wireUniverse();
  installHistoryGuard();
  show('library');
  try {
    await renderLibrary(hooks);
  } catch (err) {
    console.error(err);
    toast('Не удалось загрузить библиотеку');
  }
  // проверяем, что встроенные вселенные вообще доступны (пустые вселенные — нормальное состояние)
  try {
    const builtin = await loadBuiltinUniverses();
    markBuiltinWarning(!builtin.length);
    if (!builtin.length) await renderLibrary(hooks);
  } catch { /* ignore */ }

  if (!navigator.onLine) toast('Офлайн-режим: работает и без сети');
}

boot();
