/* VNMY — точка входа и переключение экранов */
import { renderLibrary, wireLibrary, markBuiltinWarning } from './library.js';
import { openPlayer, closePlayer } from './player.js';
import { openEditor, closeEditor } from './editor.js';
import { createStory, saveStory, loadBuiltinStories } from './store.js';
import { $ } from './util.js';
import { toast } from './ui.js';

const SCREENS = ['library', 'player', 'editor'];
let current = 'library';
let storyForPlayer = null;
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
  closeEditor();
  document.documentElement.lang = 'ru';
  show('library');
  await renderLibrary(hooks);
}

function playStory(story, opts = {}) {
  storyForPlayer = story;
  closeEditor({ silent: true });
  show('player');
  openPlayer(story, {
    ...opts,
    onExit: () => { backToLibrary(); },
    onEdit: (target) => editStory(target),
  });
  pushScreen('player');
}

function editStory(story, opts = {}) {
  closePlayer();
  show('editor');
  openEditor(story, {
    ...opts,
    onExit: () => backToLibrary(),
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
  onNew: () => {
    const story = createStory({ title: 'Новая история' });
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
    closePlayer();
    closeEditor({ silent: true });
    show('library');
    await renderLibrary(hooks);
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
  registerServiceWorker();
  wireLibrary();
  installHistoryGuard();
  show('library');
  try {
    await renderLibrary(hooks);
  } catch (err) {
    console.error(err);
    toast('Не удалось загрузить библиотеку');
  }
  // проверяем, что встроенные истории вообще доступны (например, при открытии с диска)
  try {
    const builtin = await loadBuiltinStories();
    markBuiltinWarning(!builtin.length);
    if (!builtin.length) await renderLibrary(hooks);
  } catch { /* ignore */ }

  if (!navigator.onLine) toast('Офлайн-режим: работает и без сети');
  void storyForPlayer;
}

boot();
