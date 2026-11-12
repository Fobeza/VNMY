/* VNMY — экран «Вселенные»: первый шаг выбора.
 *
 * Вселенная — это мир, внутри которого несколько новелл (js/universe.js).
 * Здесь: карточки вселенных, импорт и бэкап.
 * Список новелл вселенной — js/novels.js.
 *
 * Источники вселенных (складываются в один список, см. store.loadLibrary):
 *   1) файлы проекта: stories/<вселенная>/universe.json + novels/<новелла>/story.json;
 *   2) свои вселенные в этом браузере (localStorage «vnmy:universes»);
 *   3) «Без вселенной» — новеллы, у которых story.universe пустой.
 */
import {
  loadLibrary,
  exportBackup, storageUsage, progressOf,
} from './store.js';
import { resolveUrl } from './format.js';
import { el, $, plural } from './util.js';
import { toast } from './ui.js';
import { openImport } from './import.js';
import { openSettings } from './settings.js';
import { openStoryDetails, openUniverseMenu } from './novels.js';

let hooks = {};
let universes = [];
let builtinWarning = false;
let renderSequence = 0;

export async function renderLibrary(nextHooks) {
  const request = ++renderSequence;
  hooks = nextHooks || hooks;
  const list = $('#universe-list');
  if (!list) return;
  list.innerHTML = '';

  const lib = await loadLibrary();
  if (request !== renderSequence) return;
  list.replaceChildren();
  universes = lib.universes;
  const resumeHost = document.getElementById('continue-reading');
  resumeHost?.replaceChildren();
  const allStories = universes.flatMap(u => u.novels || []);
  const home = document.getElementById('home-stories');
  home?.replaceChildren();
  for (const story of allStories) {
    const cover = resolveUrl(story, story.cover);
    const progress = progressOf(story.id);
    home?.append(el('button', { class: 'home-story', type: 'button', onclick: () => openStoryDetails(story, hooks) },
      cover ? el('img', { src: cover, alt: '', loading: 'lazy' }) : el('span', { class: 'home-story-initial', text: story.title.slice(0, 1) }),
      el('span', { class: 'home-story-copy' }, el('strong', { text: story.title }), el('small', { text: progress ? progress.ended ? 'Прочитано' : progress.sceneName || 'Продолжить чтение' : 'Новая история' })),
      el('span', { class: 'chev', text: '›', 'aria-hidden': 'true' })));
  }
  if (!allStories.length) home?.append(el('p', { class: 'empty-library', text: 'Добавьте свою первую историю из файла .vnmy.' }));
  const latest = allStories.map(story => ({ story, save: progressOf(story.id) }))
    .filter(item => item.save && !item.save.ended).sort((a, b) => (b.save.at || 0) - (a.save.at || 0))[0];
  if (latest && resumeHost) {
    const { story, save } = latest;
    const cover = resolveUrl(story, story.cover);
    resumeHost.append(el('article', { class: 'continue-card' },
      cover ? el('img', { src: cover, alt: '', class: 'continue-cover' }) : null,
      el('div', {}, el('p', { class: 'continue-kicker', text: 'Продолжить чтение' }), el('h2', { text: story.title }),
        el('p', { class: 'field-hint', text: save.sceneName || 'Вернуться к истории' }),
        el('progress', { class: 'reading-progress', max: 1, value: Math.max(0, Math.min(1, save.percent || 0)), 'aria-label': 'Прогресс чтения' }),
        el('button', { class: 'solid-btn', type: 'button', onclick: () => hooks.onPlay?.(story) }, 'Продолжить'))));
  }

  // Все новеллы уже перечислены в «Библиотеке». Раздел вселенных нужен,
  // когда их несколько; одна вселенная — короткая строка-ссылка без заголовка.
  const named = universes.filter(u => !u.loose);
  if (named.length > 1) list.append(el('h2', { class: 'section-title', text: 'Вселенные' }));
  for (const universe of named) list.append(universeCard(universe, { compact: named.length === 1 }));

  // Подсказки нужны только пустой библиотеке; версия приложения — в настройках.
  const note = $('#library-note');
  note.replaceChildren();
  const lines = [];
  if (!allStories.length) lines.push('Нажмите «Импорт» и выберите файл новеллы .vnmy. Место чтения сохраняется автоматически.');
  if (location.protocol === 'file:' && !allStories.length) {
    lines.push('Открыто с диска: новеллы и прогресс хранятся в этом браузере — как и при обычном запуске.');
  }

  const usage = storageUsage();
  const usedMb = usage.used / 1024 / 1024;
  if (usedMb > 0.2) {
    lines.push(`На устройстве: ${usedMb.toFixed(1)} МБ${usage.limit ? ' из примерно 5 МБ' : ''}. Полная копия — кнопка «Бэкап».`);
  }
  if (builtinWarning) {
    lines.push('Встроенные вселенные не открылись. Проверьте, что папка stories на месте и страница открыта через сервер (а не как файл с диска).');
  }
  for (const line of lines) note.append(el('p', { text: line }));
  note.hidden = !lines.length;
}

function novelCount(n) {
  return `${n} ${plural(n, 'новелла', 'новеллы', 'новелл')}`;
}

function universeCard(universe, { compact = false } = {}) {
  const novels = universe.novels || [];
  // без своей обложки вселенная берёт обложку первой новеллы с обложкой
  const novelWithCover = novels.find(story => story.cover);
  const cover = universe.cover ? resolveUrl(universe, universe.cover)
    : novelWithCover ? resolveUrl(novelWithCover, novelWithCover.cover) : '';

  const card = el('div', {
    class: `universe-card${universe.builtin ? ' is-builtin' : ''}${universe.loose ? ' is-loose' : ''}${compact ? ' is-compact' : ''}`,
    role: 'button',
    tabindex: '0',
    style: universe.accent ? { '--card-accent': universe.accent } : {},
  },
  el('div', {
    class: 'universe-card-cover',
    style: cover ? { backgroundImage: `url("${cover.replace(/"/g, '%22')}")` } : {},
  }),
  cover ? null : el('div', { class: 'universe-card-initial', text: (universe.title || '?').trim().charAt(0).toUpperCase() }),
  universe.builtin ? el('span', { class: 'universe-card-badge', text: 'встроенная' }) : null,
  el('div', { class: 'universe-card-body' },
    compact ? el('div', { class: 'universe-card-kicker', text: 'Вселенная' }) : null,
    el('div', { class: 'universe-card-title', text: universe.title }),
    el('div', { class: 'universe-card-meta' }, el('span', { text: novelCount(novels.length) })),
  ),
  el('button', {
    class: 'universe-card-menu',
    type: 'button',
    'aria-label': 'Действия с вселенной',
    onclick: (e) => { e.stopPropagation(); openUniverseMenu(universe, { onOpen: () => hooks.onOpenUniverse?.(universe.id), onDeleted: () => renderLibrary(hooks) }); },
  }, el('span', { html: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>' })),
  );

  const open = () => hooks.onOpenUniverse?.(universe.id);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return card;
}

let wired = false;

export function wireLibrary() {
  if (wired) return;
  wired = true;

  $('#btn-settings')?.addEventListener('click', () => openSettings());
  $('#btn-import-story')?.addEventListener('click', () => openImport({ onImported: () => renderLibrary(hooks) }));

  $('#btn-backup')?.addEventListener('click', async () => {
    try {
      toast('Собираю полную копию…', 8000);
      const count = await exportBackup();
      toast(`Бэкап: ${count} ${plural(count, 'новелла', 'новеллы', 'новелл')}, сохранения и настройки`);
    } catch (err) {
      console.error(err);
      toast('Не удалось включить все картинки. Откройте исходную папку с изображениями и повторите бэкап.', 6000);
    }
  });
}

export function markBuiltinWarning(value) {
  builtinWarning = value;
}
