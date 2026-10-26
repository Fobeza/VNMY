/* VNMY — экран библиотеки */
import {
  loadBuiltinStories, listLocalStories, duplicateStory, deleteStory, exportStory, progressOf,
  importStoryFile, saveStory, clearSaves, getSaves,
} from './store.js';
import { countWords, resolveUrl } from './format.js';
import { el, $, formatDate, plural } from './util.js';
import { toast, openSheet, confirmDialog } from './ui.js';
import { ICONS } from './icons.js';

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
        story.readOnly ? el('span', { class: 'story-card-badge', text: 'встроенная' }) : null,
        el('span', { text: story.author || 'без автора' }),
        el('span', { class: 'sep' }),
        el('span', { text: `${steps} ${plural(steps, 'шаг', 'шага', 'шагов')}` }),
        charCount ? el('span', { class: 'sep' }) : null,
        charCount ? el('span', { text: `${charCount} ${plural(charCount, 'персонаж', 'персонажа', 'персонажей')}` }) : null,
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
      { label: 'Экспорт JSON', icon: ICONS.download, hint: 'файл можно положить в папку stories', onSelect: () => exportStory(story) },
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
      const story = await importStoryFile(file);
      saveStory(story);
      toast(`Импортировано: ${story.title}`);
      renderLibrary(hooks);
    } catch (err) {
      console.error(err);
      toast('Не получилось прочитать файл истории');
    }
  });
  $('#btn-import-story').addEventListener('click', () => fileInput.click());
}

export function markBuiltinWarning(value) {
  builtinWarning = value;
}
