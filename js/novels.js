/* VNMY — экран «Новеллы вселенной»: второй шаг выбора.
 *
 * Здесь живой список новелл одной вселенной: карточки, меню истории
 * (играть / редактировать / копировать / экспорт / удалить) и импорт файла.
 * Новеллы группируются по полю story.universe (см. js/universe.js).
 */
import {
  loadLibrary, duplicateStory, deleteStory, exportStory, progressOf, getSaves,
  importStoryFile, clearSaves, exportStoryPortable, universeCatalog,
  deleteUniverse, exportUniversePortable, moveStoryToUniverse, getSettings,
} from './store.js';
import { countWords, resolveUrl } from './format.js';
import { el, $, formatDate, plural } from './util.js';
import { toast, openSheet, confirmDialog } from './ui.js';
import { ICONS } from './icons.js';
import { promptUniverse } from './library.js';

let hooks = {};
let current = null;

/** Открыть экран вселенной (вызывается из app.js). */
export async function renderUniverse(universeId, nextHooks) {
  hooks = nextHooks || hooks;
  const lib = await loadLibrary();
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
  document.documentElement.style.setProperty('--accent', universe?.accent || '#e0b072');

  const novels = universe?.novels || [];
  const newBtn = $('#btn-new-story');
  if (newBtn) newBtn.hidden = !universe;
  const importBtn = $('#btn-import-novel');
  if (importBtn) importBtn.hidden = !universe;
  const menuBtn = $('#uni-menu');
  if (menuBtn) menuBtn.hidden = !universe;

  if (!novels.length) {
    list.append(el('p', { class: 'lib-note', text: universe?.builtin
      ? 'В этой вселенной пока нет новелл. Создайте новую — она появится здесь и в списке своих новелл.'
      : 'Пока пусто. Нажмите «Новая новелла» — или положите папку stories/<вселенная>/novels/<имя>/ в проект и соберите (npm run build).' }));
  }
  for (const story of novels) list.append(storyCard(story));

  const note = $('#novels-note');
  if (note) {
    note.innerHTML = '';
    if (universe?.builtin) {
      note.append(el('span', { text: 'Встроенные новеллы читаются только для просмотра: «Редактировать» создаёт вашу копию. Свои новеллы этой вселенной хранятся в этом браузере.' }));
    }
    if (!universe?.builtin && universe) {
      note.append(el('span', { text: 'Ваша вселенная: новеллы и правки хранятся в этом браузере. Экспорт вселенной — в меню «⋯» сверху.' }));
    }
  }
  return universe;
}

function countNovels(n) {
  return `${n} ${plural(n, 'новелла', 'новеллы', 'новелл')}`;
}

function storyCard(story) {
  const { steps } = countWords(story);
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

  const open = () => hooks.onPlay(story);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); }
  });
  return card;
}

/** Меню одной новеллы. */
function openStoryMenu(story) {
  const saves = getSaves(story.id);
  const hasProgress = !!(saves.auto || saves.slots.length);
  const universes = universeCatalog().filter((u) => u.id !== story.universe);
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
          const ok = await confirmDialog({ title: 'Начать сначала?', text: 'Сохранённый прогресс этой новеллы удалится.', confirmText: 'Начать сначала', danger: false });
          if (!ok) return;
          clearSaves(story.id);
          hooks.onPlay(story, { fresh: true });
        },
      } : null,
      {
        authorOnly: true, label: story.readOnly ? 'Редактировать копию' : 'Редактировать',
        icon: ICONS.edit,
        hint: story.readOnly ? 'оригинал останется в папке stories' : 'изменения сохранятся в браузере',
        onSelect: async () => {
          const target = story.readOnly ? duplicateStory(story) : story;
          if (story.readOnly) toast('Создана ваша копия новеллы');
          hooks.onEdit(target);
        },
      },
      universes.length ? {
        authorOnly: true, label: 'Перенести в другую вселенную',
        icon: ICONS.book,
        hint: universes.map((u) => u.title).join(', ').slice(0, 60),
        onSelect: () => pickUniverseFor(story),
      } : null,
      {
        authorOnly: true, label: 'Дублировать',
        icon: ICONS.copy,
        onSelect: () => { duplicateStory(story); toast('Копия создана'); renderUniverse(current?.id ?? '', hooks); },
      },
      {
        authorOnly: true, label: 'Экспорт с картинками',
        icon: ICONS.download,
        hint: 'один файл, откроется на любом устройстве',
        onSelect: () => runPortableExport(story),
      },
      {
        authorOnly: true, label: 'Экспорт JSON',
        icon: ICONS.download,
        hint: 'только сценарий, картинки — путями из stories/',
        onSelect: () => exportStory(story),
      },
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

/** Перенос новеллы в другую вселенную — шторка со списком. */
function pickUniverseFor(story) {
  const rows = [
    ...universeCatalog().filter((u) => u.id !== story.universe).map((u) => ({
      label: u.title,
      value: countNovels(u.novels?.length || 0),
      onSelect: () => {
        moveStoryToUniverse(story, u.id);
        toast(`Новелла теперь в «${u.title}»`);
        renderUniverse(current?.id ?? '', hooks);
      },
    })),
    {
      label: 'Без вселенной',
      onSelect: () => {
        moveStoryToUniverse(story, '');
        toast('Новелла вынесена из вселенной');
        renderUniverse(current?.id ?? '', hooks);
      },
    },
  ];
  openSheet({ title: 'Куда перенести?', subtitle: story.title, rows });
}

async function runPortableExport(story) {
  toast('Собираю картинки…', 8000);
  try {
    const result = await exportStoryPortable(story);
    if (result.skipped) {
      toast(`Готово: ${(result.bytes / 1024 / 1024).toFixed(1)} МБ, ${result.images} картинок. ${result.skipped} не удалось вшить.`);
    } else {
      toast(`Готово: ${(result.bytes / 1024 / 1024).toFixed(1)} МБ, картинок: ${result.images}`);
    }
  } catch (err) {
    console.error(err);
    toast('Не получилось собрать файл');
  }
}

/** Импорт новеллы прямо в эту вселенную. */
async function runImport(file, universeId) {
  try {
    const imported = await importStoryFile(file);
    if (!imported.length) {
      toast('В файле не нашлось новелл', 4000);
      return;
    }
    if (imported.universe) {
      toast(`Вселенная «${imported.universe.title}»: новелл ${imported.length}`, 4000);
    } else {
      // новелла без вселенной попадает в ту, внутри которой её импортировали
      if (universeId) {
        for (const story of imported) if (!story.universe) moveStoryToUniverse(story, universeId);
      }
      toast(imported.length > 1
        ? `Импортировано новелл: ${imported.length}`
        : `Импортировано: «${imported[0].title}»`, 3200);
    }
  } catch (err) {
    const code = String(err?.message || '');
    if (code === 'STORAGE_FULL') {
      const partial = err.imported?.length || 0;
      toast(partial
        ? `Место кончилось: загружено ${partial}. Удалите лишние новеллы или грузите картинки файлами.`
        : 'В браузере мало места для этой новеллы. Удалите что-нибудь или держите картинки в папке stories.', 6000);
    } else if (code === 'BAD_JSON') {
      toast('Это не файл истории VNMY: внутри не JSON', 4000);
    } else {
      console.error(err);
      toast('Не получилось прочитать файл', 4000);
    }
  } finally {
    await renderUniverse(current?.id ?? universeId ?? '', hooks);
  }
}

/** Меню вселенной: переименовать / экспорт / удалить. */
function openUniverseMenu() {
  const universe = current;
  if (!universe) return;
  const canEdit = !universe.builtin && !universe.loose;
  openSheet({
    title: universe.title,
    subtitle: universe.loose
      ? 'Новеллы без вселенной'
      : `${countNovels(universe.novels?.length || 0)}${universe.builtin ? ' · из папки stories' : ''}`,
    rows: [
      canEdit ? {
        label: 'Название и описание',
        icon: ICONS.edit,
        onSelect: () => promptUniverse({
          universe,
          onSave: () => { renderUniverse(universe.id, hooks); },
        }),
      } : null,
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
          hooks.onBack?.();
        },
      } : null,
    ],
  });
}

async function runUniverseExport(universe) {
  toast('Собираю новеллы…', 8000);
  try {
    const result = await exportUniversePortable(universe, universe.novels || []);
    toast(`Готово: ${(result.bytes / 1024 / 1024).toFixed(1)} МБ, новелл: ${result.novels}, картинок: ${result.images}`);
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
  $('#btn-new-story')?.addEventListener('click', () => hooks.onNew?.(current?.id || ''));
  $('#uni-menu')?.addEventListener('click', openUniverseMenu);

  const fileInput = el('input', { type: 'file', class: 'js-import-novel', accept: 'application/json,.json', style: { display: 'none' } });
  document.body.append(fileInput);
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    await runImport(file, current?.id || '');
  });
  $('#btn-import-novel')?.addEventListener('click', () => fileInput.click());
}
