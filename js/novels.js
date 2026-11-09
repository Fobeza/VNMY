/* VNMY — экран «Новеллы вселенной»: второй шаг выбора.
 *
 * Здесь живой список новелл одной вселенной: карточки, меню истории
 * (играть / начать сначала / удалить) и импорт файла.
 * Новеллы группируются по полю story.universe (см. js/universe.js).
 */
import {
  loadLibrary, deleteStory, progressOf, getSaves,
  deleteSave,
  deleteUniverse, exportUniversePortable,
} from './store.js';
import { countWords, resolveUrl } from './format.js';
import { el, $, formatDate, plural } from './util.js';
import { toast, openSheet, confirmDialog } from './ui.js';
import { openImport } from './import.js';
import { openSaves } from './player.js';
import { openGallery } from './gallery.js';
import { ICONS } from './icons.js';

let hooks = {};
let current = null;
let renderSequence = 0;

/** Открыть экран вселенной (вызывается из app.js). */
export async function renderUniverse(universeId, nextHooks) {
  const request = ++renderSequence;
  hooks = nextHooks || hooks;
  const lib = await loadLibrary();
  if (request !== renderSequence) return;
  const universe = lib.universes.find((u) => u.id === universeId)
    || lib.universes.find((u) => u.loose)
    || lib.universes[0];
  current = universe || null;

  const list = $('#story-list');
  if (!list) return;
  list.innerHTML = '';

  $('#uni-title').textContent = universe ? universe.title : 'Вселенная';
  const desc = $('#uni-desc');
  desc.textContent = universe?.description || '';
  desc.hidden = !universe?.description;
  document.documentElement.style.setProperty('--accent', '#8d9af2');

  const novels = universe?.novels || [];
  const importBtn = $('#btn-import-novel');
  if (importBtn) importBtn.hidden = !universe;
  const menuBtn = $('#uni-menu');
  if (menuBtn) menuBtn.hidden = !universe;

  if (!novels.length) {
    list.append(el('p', { class: 'lib-note', text: universe?.builtin
      ? 'В этой вселенной пока нет новелл. Добавьте новеллу кнопкой «Импортировать .vnmy».'
      : 'Пока пусто. Добавьте новеллу кнопкой «Импортировать .vnmy».' }));
  }
  for (const story of novels) list.append(storyCard(story));

  const note = $('#novels-note');
  if (note) {
    note.innerHTML = '';
    if (universe?.builtin) {
      note.append(el('span', { text: 'Импортированные новеллы этой вселенной хранятся в этом браузере.' }));
    }
    if (!universe?.builtin && universe) {
      note.append(el('span', { text: 'Новеллы этой вселенной хранятся в этом браузере. Экспорт вселенной — в меню «⋯» сверху.' }));
    }
  }
  return universe;
}

function countNovels(n) {
  return `${n} ${plural(n, 'новелла', 'новеллы', 'новелл')}`;
}

function storyCard(story) {
  const cover = story.cover ? resolveUrl(story, story.cover) : '';
  const progress = progressOf(story.id);
  const charCount = story.characters.length;

  const card = el('div', { class: `story-card${story.readOnly ? ' is-builtin' : ''}`, role: 'button', tabindex: '0' },
    el('div', { class: 'story-card-cover', style: cover ? { backgroundImage: `url("${cover.replace(/"/g, '%22')}")` } : {} }),
    el('div', { class: 'story-card-body' },
      el('div', { class: 'story-card-title', text: story.title }),
      el('div', { class: 'story-card-meta' },
        el('span', { text: story.author || 'без автора' }),
        el('span', { class: 'sep' }),
        el('span', { text: `${Math.max(1, Math.round(countWords(story).words / 180))} мин · все ветки` }),
        charCount ? el('span', { class: 'sep' }) : null,
        charCount ? el('span', { text: `${charCount} ${plural(charCount, 'персонаж', 'персонажа', 'персонажей')}` }) : null,
        story.readOnly ? el('span', { class: 'story-card-badge', text: 'встроенная' }) : null,
      ),
      story.description ? el('div', { class: 'story-card-desc', text: story.description }) : null,
      progress ? el('div', { class: 'story-card-meta', style: { color: 'var(--accent)', marginTop: '2px' } },
        el('span', { text: progress.ended ? 'прочитано · можно перечитать' : `продолжить · ${progress.sceneName || 'начало'}` }),
      ) : null,
    ),
    el('button', {
      class: 'story-card-menu',
      type: 'button',
      'aria-label': 'Действия с историей',
      onclick: (e) => { e.stopPropagation(); openStoryMenu(story); },
    }, el('span', { html: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>' })),

  );

  const open = () => openStoryDetails(story);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); }
  });
  return card;
}

export function openStoryDetails(story, actions = hooks) {
  const save = progressOf(story.id);
  const cover = resolveUrl(story, story.cover);
  let close;
  close = openSheet({ layout: 'page', title: 'Об истории', onMenu: () => openSheet({ title: story.title, rows: [
    { label: 'Сохранения', icon: ICONS.download, onSelect: () => openSaves(story, { onLoad: slot => { close(); actions.onPlay?.(story, { slot }); } }, 'load') },
    { label: 'Галерея', icon: ICONS.image, onSelect: () => openGallery(story) },
  ] }), content: close => el('div', { class: 'story-details' },
    cover ? el('img', { class: 'detail-cover', src: cover, alt: '' }) : null,
    el('h2', { text: story.title }),
    story.genres?.length ? el('div', { class: 'genre-chips' }, ...story.genres.map(text => el('span', { text }))) : null,
    story.author ? el('p', { class: 'field-hint', text: story.author }) : null,
    story.description ? el('p', { class: 'detail-description', text: story.description }) : null,
    save ? el('p', { class: 'field-hint', text: save.ended ? 'История прочитана' : save.sceneName || 'Чтение начато' }) : null,
    save ? el('progress', { class: 'reading-progress', max: 1, value: Math.max(0, Math.min(1, save.percent || 0)), 'aria-label': 'Прогресс чтения' }) : null,
    el('button', { class: 'solid-btn', type: 'button', text: save && !save.ended ? 'Продолжить' : 'Начать историю', onclick: () => { close(); actions.onPlay?.(story, { fresh: !!save?.ended }); } }),
    save ? el('button', { class: 'ghost-btn', type: 'button', text: 'Начать заново', onclick: async () => {
      if (!await confirmDialog({ title: 'Начать заново?', text: 'Ручные сохранения останутся.', confirmText: 'Начать', danger: false })) return;
      deleteSave(story.id, 'auto'); close(); actions.onPlay?.(story, { fresh: true });
    } }) : null,
    el('button', { class: 'sheet-row detail-link', type: 'button', html: `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS.download}</svg><span>Сохранения</span><span class="chev">›</span>`, onclick: () => openSaves(story, { onLoad: slot => { close(); actions.onPlay?.(story, { slot }); } }, 'load') }),
    el('button', { class: 'sheet-row detail-link', type: 'button', html: `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS.image}</svg><span>Галерея</span><span class="chev">›</span>`, onclick: () => openGallery(story) }),
  ) });
  return close;
}

/** Меню одной новеллы. */
function openStoryMenu(story) {
  const saves = getSaves(story.id);
  const hasProgress = !!(saves.auto || saves.slots.length);
  openSheet({
    title: story.title,
    subtitle: story.readOnly ? 'Встроенная новелла · только для чтения' : `Изменена ${formatDate(story.updatedAt)}`,
    rows: [
      { label: 'Играть', icon: ICONS.play, onSelect: () => hooks.onPlay(story) },
      hasProgress ? {
        label: 'Начать сначала',
        icon: ICONS.restart,
        hint: 'прогресс будет сброшен',
        onSelect: async () => {
          const ok = await confirmDialog({ title: 'Начать сначала?', text: 'Автосохранение сбросится. Ручные слоты и отметки «прочитано» останутся.', confirmText: 'Начать сначала', danger: false });
          if (!ok) return;
          deleteSave(story.id, 'auto');
          hooks.onPlay(story, { fresh: true });
        },
      } : null,
      !story.readOnly ? {
        label: 'Удалить новеллу',
        icon: ICONS.trash,
        danger: true,
        onSelect: async () => {
          const ok = await confirmDialog({ title: 'Удалить новеллу?', text: `«${story.title}» и её прогресс будут удалены из этого браузера.`, confirmText: 'Удалить' });
          if (!ok) return;
          deleteStory(story.id);
          toast('Новелла удалена');
          renderUniverse(current?.id ?? '', hooks);
        },
      } : null,
    ],
  });
}

/**
 * Меню вселенной — общее для карточки в библиотеке и экрана вселенной.
 * onOpen добавляет пункт «Открыть»; onDeleted вызывается после удаления.
 */
export function openUniverseMenu(universe, { onOpen, onDeleted } = {}) {
  if (!universe) return;
  const canEdit = !universe.builtin && !universe.loose;
  openSheet({
    title: universe.title,
    subtitle: universe.loose
      ? 'Новеллы без вселенной'
      : `${countNovels(universe.novels?.length || 0)}${universe.builtin ? ' · встроенная' : ''}`,
    rows: [
      onOpen ? { label: 'Открыть', icon: ICONS.play, onSelect: onOpen } : null,
      {
        label: 'Экспорт вселенной',
        icon: ICONS.download,
        hint: 'одним файлом: все новеллы и картинки',
        onSelect: () => runUniverseExport(universe),
      },
      canEdit ? {
        label: 'Удалить вселенную',
        icon: ICONS.trash,
        danger: true,
        hint: 'новеллы останутся, но без вселенной',
        onSelect: async () => {
          const ok = await confirmDialog({ title: 'Удалить вселенную?', text: `«${universe.title}» исчезнет из списка. Новеллы останутся и попадут в «Без вселенной».`, confirmText: 'Удалить' });
          if (!ok) return;
          deleteUniverse(universe.id);
          toast('Вселенная удалена');
          onDeleted?.();
        },
      } : null,
    ],
  });
}

async function runUniverseExport(universe) {
  toast('Собираю новеллы…', 8000);
  try {
    const result = await exportUniversePortable(universe, universe.novels || []);
    toast(`Готово: ${(result.bytes / 1024 / 1024).toFixed(1)} МБ, новелл: ${result.novels}, файлов: ${result.images}`);
  } catch (err) {
    console.error(err);
    toast('Не получилось собрать вселенную');
  }
}

let wired = false;

/** Кнопки экрана вселенной — один раз при старте. */
export function wireUniverse() {
  if (wired) return;
  wired = true;

  $('#uni-back')?.addEventListener('click', () => hooks.onBack?.());
  $('#uni-menu')?.addEventListener('click', () => openUniverseMenu(current, { onDeleted: () => hooks.onBack?.() }));

  $('#btn-import-novel')?.addEventListener('click', () => openImport({ universeId: current?.id || '', onImported: () => renderUniverse(current?.id || '', hooks) }));
}
