/* VNMY — экран библиотеки */
import {
  loadBuiltinStories, listLocalStories, duplicateStory, deleteStory, exportStory, progressOf,
  importStoryFile, saveStory, clearSaves, getSaves, exportBackup, exportStoryPortable, storageUsage, listLocalStoryIds,
} from './store.js';
import { countWords, resolveUrl } from './format.js';
import { el, $, formatDate, plural } from './util.js';
import { toast, openSheet, confirmDialog } from './ui.js';
import { ICONS } from './icons.js';
import { APP_VERSION } from './version.js';

let hooks = {};
let stories = [];
let builtinWarning = false;

export async function renderLibrary(nextHooks) {
  hooks = nextHooks;
  const list = $('#story-list');
  list.innerHTML = '';
  const [builtin, local] = await Promise.all([loadBuiltinStories(), Promise.resolve(listLocalStories())]);
  stories = [...local.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)), ...builtin];

  if (!stories.length) {
    list.append(el('p', { class: 'lib-note', text: 'Пока нет ни одной истории. Создайте новую или добавьте файл в папку stories.' }));
    return;
  }

  for (const story of stories) list.append(storyCard(story));

  const note = $('#library-note');
  note.innerHTML = '';
  note.append(
    el('span', { text: 'Свои истории добавляются в папку ' }),
    el('code', { text: 'stories/' }),
    el('span', { text: ' — по одной папке на историю. Здесь же их можно создать и отредактировать: правки хранятся в этом браузере.' }),
  );
  if (location.protocol === 'file:') {
    note.append(el('br'), el('br'), el('span', {
      text: 'Открыто с диска: встроенные истории работают сразу, а свои и прогресс хранятся в этом браузере — как и при обычном запуске.',
    }));
  }
  note.append(el('br'), el('br'), el('span', { class: 'lib-version', text: `VNMY ${APP_VERSION}` }));

  const usage = storageUsage();
  const usedMb = usage.used / 1024 / 1024;
  if (usedMb > 0.2) {
    note.append(el('br'), el('br'), el('span', {
      text: `Занято в браузере: ${usedMb.toFixed(1)} МБ из ~5 МБ (${Math.round((usage.used / usage.limit) * 100)}%). Бэкап — кнопка «Бэкап» вверху.`,
    }));
  }
  if (builtinWarning) {
    note.append(el('br'), el('br'), el('span', { text: 'Встроенные истории не открылись. Проверьте, что папка stories на месте и страница открыта через сервер (а не как файл с диска).' }));
  }
}

function storyCard(story) {
  const { words, steps } = countWords(story);
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
        el('span', { text: `${steps} ${plural(steps, 'шаг', 'шага', 'шагов')}` }),
        charCount ? el('span', { class: 'sep' }) : null,
        charCount ? el('span', { text: `${charCount} ${plural(charCount, 'персонаж', 'персонажа', 'персонажей')}` }) : null,
        story.readOnly ? el('span', { class: 'story-card-badge', text: 'встроенная' }) : null,
      ),
      story.description ? el('div', { class: 'story-card-desc', text: story.description }) : null,
      progress ? el('div', { class: 'story-card-meta', style: { color: 'var(--accent)', marginTop: '2px' } },
        el('span', { text: progress.ended ? 'прочитано · можно перечитать' : `продолжить · ${Math.round((progress.percent || 0) * 100)}%` }),
      ) : null,
    ),
    el('button', {
      class: 'story-card-menu',
      type: 'button',
      'aria-label': 'Действия с историей',
      onclick: (e) => { e.stopPropagation(); openStoryMenu(story); },
    }, el('span', { html: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>' })),
    progress && !progress.ended ? el('div', { class: 'story-card-progress', style: { transform: `scaleX(${Math.min(1, Math.max(.02, progress.percent || 0))})` } }) : null,
  );

  const open = () => hooks.onPlay(story);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  void words;
  return card;
}

function openStoryMenu(story) {
  const saves = getSaves(story.id);
  const hasProgress = !!(saves.auto || saves.slots.length);
  openSheet({
    title: story.title,
    subtitle: story.readOnly ? 'Встроенная история · только для чтения' : `Изменена ${formatDate(story.updatedAt)}`,
    rows: [
      { label: 'Играть', icon: ICONS.play, onSelect: () => hooks.onPlay(story) },
      hasProgress ? {
        label: 'Начать сначала',
        icon: ICONS.restart,
        hint: 'прогресс будет сброшен',
        onSelect: async () => {
          const ok = await confirmDialog({ title: 'Начать сначала?', text: 'Сохранённый прогресс этой истории удалится.', confirmText: 'Начать сначала', danger: false });
          if (!ok) return;
          clearSaves(story.id);
          hooks.onPlay(story, { fresh: true });
        },
      } : null,
      {
        label: story.readOnly ? 'Редактировать копию' : 'Редактировать',
        icon: ICONS.edit,
        hint: story.readOnly ? 'оригинал останется в папке stories' : 'изменения сохранятся в браузере',
        onSelect: async () => {
          const target = story.readOnly ? duplicateStory(story) : story;
          if (story.readOnly) toast('Создана ваша копия истории');
          hooks.onEdit(target);
        },
      },
      {
        label: 'Дублировать',
        icon: ICONS.copy,
        onSelect: () => { const copy = duplicateStory(story); toast('Копия создана'); renderLibrary(hooks); void copy; },
      },
      {
        label: 'Экспорт с картинками',
        icon: ICONS.download,
        hint: 'один файл, откроется на любом устройстве',
        onSelect: () => runPortableExport(story),
      },
      {
        label: 'Экспорт JSON',
        icon: ICONS.download,
        hint: 'только сценарий, картинки — путями из stories/',
        onSelect: () => exportStory(story),
      },
      !story.readOnly ? {
        label: 'Удалить историю',
        icon: ICONS.trash,
        danger: true,
        onSelect: async () => {
          const ok = await confirmDialog({ title: 'Удалить историю?', text: `«${story.title}» и её прогресс будут удалены из этого браузера.`, confirmText: 'Удалить' });
          if (!ok) return;
          deleteStory(story.id);
          toast('История удалена');
          renderLibrary(hooks);
        },
      } : null,
    ],
  });
  void hasProgress;
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

export function wireLibrary() {
  $('#btn-new-story').addEventListener('click', () => {
    const story = hooks.onNew();
    void story;
  });

  const fileInput = el('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' } });
  document.body.append(fileInput);
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const imported = await importStoryFile(file);
      const titles = imported.map((s) => `«${s.title}»`).join(', ');
      toast(imported.length > 1 ? `Импортировано: ${imported.length} истории` : `Импортировано: ${titles}`, 3200);
    } catch (err) {
      const code = String(err?.message || '');
      if (code === 'BAD_JSON' || code === 'STORAGE_FULL') console.warn('[vnmy] импорт:', err.message);
      else console.error(err);
          if (code === 'STORAGE_FULL') {
        const partial = err.imported?.length || 0;
        toast(partial
          ? `Место кончилось: загружено ${partial} из файла. Удалите лишние истории или загружайте картинки файлами.`
          : 'В браузере мало места для этой истории. Удалите что-нибудь или держите картинки в папке stories.', 6000);
      } else if (code === 'BAD_JSON') {
        toast('Это не файл истории VNMY: внутри не JSON', 4000);
      } else {
        toast('Не получилось прочитать файл истории', 4000);
      }
    } finally {
      // одно обновление библиотеки на одну попытку импорта
      await renderLibrary(hooks);
    }
  });
  $('#btn-import-story').addEventListener('click', () => fileInput.click());

  $('#btn-backup').addEventListener('click', () => {
    if (!listLocalStoryIds().length) {
      toast('В браузере пока нет своих историй — бэкапить нечего');
      return;
    }
    const count = exportBackup();
    toast(`Бэкап: ${count} ${plural(count, 'история', 'истории', 'историй')}`);
  });
}

export function markBuiltinWarning(value) {
  builtinWarning = value;
}
