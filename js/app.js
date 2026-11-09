/* VNMY — точка входа и переключение экранов.
 *
 * Экраны: вселенные → новеллы вселенной → игра.
 */
import { renderLibrary, wireLibrary, markBuiltinWarning } from './library.js';
import { renderUniverse, wireUniverse } from './novels.js';
import { openPlayer, closePlayer } from './player.js';
import { loadBuiltinUniverses, builtinIsBroken, initializeStorage } from './store.js';
import { $ } from './util.js';
import { toast, closeTopModal, closeAllModals } from './ui.js';

const SCREENS = ['library', 'universe', 'player'];
let current = 'library';
/** Открытая вселенная — запасной путь «назад», если история браузера недоступна. */
let lastUniverseId = null;

/* История браузера повторяет глубину экранов: библиотека (без записи) →
 * вселенная → игра. Кнопки «назад» в приложении делают history.back(),
 * поэтому записи не копятся, а «Назад» телефона ведёт туда же. */
const depth = () => (history.state?.vnmy ? Number(history.state.depth) || 1 : 0);

function show(name) {
  closeAllModals();
  for (const id of SCREENS) {
    const node = $(`#screen-${id}`);
    if (node) node.hidden = id !== name;
  }
  document.body.dataset.screen = name;
  current = name;
  window.scrollTo({ top: 0 });
}

async function showLibrary() {
  closePlayer();
  document.documentElement.lang = 'ru';
  document.documentElement.style.removeProperty('--accent');
  lastUniverseId = null;
  show('library');
  await renderLibrary(hooks);
}

async function showUniverse(universeId) {
  closePlayer();
  document.documentElement.lang = 'ru';
  lastUniverseId = universeId;
  show('universe');
  await renderUniverse(universeId, hooks);
}

/** Состояние истории, соответствующее показанному экрану. */
let shownState = null;

function pushScreen(screen, extra = {}) {
  try {
    shownState = { vnmy: screen, depth: depth() + 1, ...extra };
    history.pushState(shownState, '', location.pathname + location.search);
    return true;
  } catch { return false; } // file:// может запрещать pushState
}

/** Экран, записанный в истории браузера. */
async function showState(state) {
  if (!state?.vnmy) return showLibrary();
  if (state.vnmy === 'universe') return showUniverse(state.universeId ?? '');
  // запись игры без открытой игры (вперёд по истории) — возвращаемся назад
  if (current !== 'player') history.back();
}

async function openUniverseScreen(universeId) {
  pushScreen('universe', { universeId });
  return showUniverse(universeId);
}

/** Назад на один экран: игра → откуда открыли, вселенная → библиотека. */
async function goBack() {
  if (depth() > 0) { history.back(); return; }
  if (current === 'player' && lastUniverseId !== null) return showUniverse(lastUniverseId);
  return showLibrary();
}

/** В главное меню: снимаем со стека все экраны приложения. */
async function backToLibrary() {
  const steps = depth();
  if (steps > 0) { history.go(-steps); return; }
  return showLibrary();
}

function playStory(story, opts = {}) {
  show('player');
  openPlayer(story, {
    ...opts,
    onHome: () => backToLibrary(),
    onExit: () => { goBack(); },
  });
  pushScreen('player');
}

const hooks = {
  onPlay: (story, opts) => playStory(story, opts),
  onOpenUniverse: (universeId) => openUniverseScreen(universeId),
  onBack: () => goBack(),
};

let guardInstalled = false;
function installHistoryGuard() {
  if (guardInstalled) return;
  guardInstalled = true;
  // после перезагрузки страницы старые записи приложения ничего не значат
  try { if (history.state?.vnmy) history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
  shownState = history.state;
  window.addEventListener('popstate', async (event) => {
    // «Назад» телефона сначала закрывает открытое окно, а экран остаётся
    if (closeTopModal()) {
      try { history.pushState(shownState, '', location.pathname + location.search); } catch { /* ignore */ }
      return;
    }
    shownState = event.state;
    await showState(event.state);
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
  // проверяем, что встроенные вселенные вообще доступны
  // (пустой каталог — нормальное состояние: в поставке может не быть историй)
  try {
    await loadBuiltinUniverses();
    markBuiltinWarning(builtinIsBroken());
    if (builtinIsBroken()) await renderLibrary(hooks);
  } catch { /* ignore */ }

  if (!navigator.onLine) toast('Офлайн-режим: работает и без сети');
}

boot();
