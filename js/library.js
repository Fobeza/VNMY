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
  loadLibrary, deleteUniverse,
  importStoryFile, exportBackup, listLocalStoryIds, storageUsage, exportUniversePortable, progressOf,
} from './store.js';
import { resolveUrl } from './format.js';
import { el, $, plural } from './util.js';
import { toast, openSheet, confirmDialog } from './ui.js';
import { ICONS } from './icons.js';
import { APP_VERSION } from './version.js';

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
  const latest = universes.flatMap(u => u.novels || []).map(story => ({ story, save: progressOf(story.id) }))
    .filter(item => item.save && !item.save.ended).sort((a, b) => (b.save.at || 0) - (a.save.at || 0))[0];
  if (latest && resumeHost) {
    const { story, save } = latest;
    const cover = resolveUrl(story, story.cover);
    resumeHost.append(el('article', { class: 'continue-card' },
      cover ? el('img', { src: cover, alt: '', class: 'continue-cover' }) : null,
      el('div', {}, el('p', { class: 'continue-kicker', text: 'Продолжить чтение' }), el('h2', { text: story.title }),
        el('p', { class: 'field-hint', text: save.sceneName || 'Вернуться к истории' }),
        el('button', { class: 'solid-btn', type: 'button', onclick: () => hooks.onPlay?.(story) }, 'Продолжить'))));
  }

  if (!universes.length) {
    list.append(el('p', { class: 'lib-note', text: 'Пока нет ни одной вселенной. Импортируйте новеллу в формате JSON или добавьте её в stories/ и соберите проект.' }));
  }
  for (const universe of universes) list.append(universeCard(universe));

  const note = $('#library-note');
  note.innerHTML = '';
  note.append(
    el('span', { text: 'Выберите вселенную и откройте историю. Ваше место сохраняется автоматически.' }),
  );
  if (location.protocol === 'file:') {
    note.append(el('br'), el('br'), el('span', {
      text: 'Открыто с диска: встроенные вселенные работают сразу, а свои и прогресс хранятся в этом браузере — как и при обычном запуске.',
    }));
  }
  note.append(el('br'), el('br'), el('span', { class: 'lib-version', text: `VNMY ${APP_VERSION}` }));

  const usage = storageUsage();
  const usedMb = usage.used / 1024 / 1024;
  if (usedMb > 0.2) {
    note.append(el('br'), el('br'), el('span', {
      text: `На устройстве: ${usedMb.toFixed(1)} МБ${usage.limit ? ' из примерно 5 МБ' : ''}. Полная копия — кнопка «Бэкап» на главном экране.`,
    }));
  }
  if (builtinWarning) {
    note.append(el('br'), el('br'), el('span', { text: 'Встроенные вселенные не открылись. Проверьте, что папка stories на месте и страница открыта через сервер (а не как файл с диска).' }));
  }
}

function novelCount(n) {
  return `${n} ${plural(n, 'новелла', 'новеллы', 'новелл')}`;
}

function universeCard(universe) {
  const novels = universe.novels || [];
  const cover = universe.cover ? resolveUrl(universe, universe.cover) : '';

  const card = el('div', {
    class: `universe-card${universe.builtin ? ' is-builtin' : ''}${universe.loose ? ' is-loose' : ''}`,
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
    el('div', { class: 'universe-card-title', text: universe.title }),
    el('div', { class: 'universe-card-meta' }, el('span', { text: novelCount(novels.length) })),
  ),
  el('button', {
    class: 'universe-card-menu',
    type: 'button',
    'aria-label': 'Действия с вселенной',
    onclick: (e) => { e.stopPropagation(); openUniverseMenu(universe); },
  }, el('span', { html: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>' })),
  );

  const open = () => hooks.onOpenUniverse?.(universe.id);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return card;
}

/** Меню вселенной на главном экране. */
function openUniverseMenu(universe) {
  const canEdit = !universe.builtin && !universe.loose;
  openSheet({
    title: universe.title,
    subtitle: `${novelCount((universe.novels || []).length)}${universe.builtin ? ' · из папки stories' : ''}`,
    rows: [
      { label: 'Открыть', icon: ICONS.play, onSelect: () => hooks.onOpenUniverse?.(universe.id) },
      {
        label: 'Экспорт вселенной',
        icon: ICONS.download,
        hint: 'все новеллы и картинки одним файлом',
        onSelect: () => runUniverseExport(universe),
      },
      canEdit ? {
        label: 'Удалить вселенную',
        icon: ICONS.trash,
        danger: true,
        hint: 'новеллы останутся, но без вселенной',
        onSelect: async () => {
          const ok = await confirmDialog({
            title: 'Удалить вселенную?',
            text: `«${universe.title}» исчезнет из списка. Новеллы останутся и попадут в «Без вселенной».`,
            confirmText: 'Удалить',
          });
          if (!ok) return;
          deleteUniverse(universe.id);
          toast('Вселенная удалена');
          renderLibrary(hooks);
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

export function wireLibrary() {
  if (wired) return;
  wired = true;

  const fileInput = el('input', { type: 'file', class: 'js-import-library', accept: 'application/json,.json', style: { display: 'none' } });
  document.body.append(fileInput);
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const imported = await importStoryFile(file);
      if (!imported.length) {
        toast('В файле не нашлось новелл', 4000);
        return;
      }
      if (imported.universe) {
        toast(`Вселенная «${imported.universe.title}»: новелл ${imported.length}`, 3600);
      } else {
        const titles = imported.map((s) => `«${s.title}»`).join(', ');
        toast(imported.length > 1 ? `Импортировано новелл: ${imported.length}` : `Импортировано: ${titles}`, 3200);
      }
    } catch (err) {
      const code = String(err?.message || '');
      if (code === 'STORAGE_FULL') {
        const partial = err.imported?.length || 0;
        toast(partial
          ? `Место кончилось: загружено ${partial} из файла. Удалите лишние новеллы или загружайте картинки файлами.`
          : 'В браузере мало места для этой новеллы. Удалите что-нибудь или держите картинки в папке stories.', 6000);
      } else if (code === 'BAD_JSON') {
        toast('Это не файл истории VNMY: внутри не JSON', 4000);
      } else {
        console.error(err);
        toast('Не получилось прочитать файл', 4000);
      }
    } finally {
      await renderLibrary(hooks);
    }
  });
  $('#btn-import-story')?.addEventListener('click', () => fileInput.click());

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
