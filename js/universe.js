/* VNMY — вселенная: общий мир, в котором живёт несколько новелл.
 *
 * Вселенная (universe.json в папке stories/<вселенная>/)
 * {
 *   id,          // латиницей: попадает в путь папки и в story.universe
 *   title,       // как показывать в библиотеке
 *   author,
 *   description, // одна-две строки под названием
 *   cover,       // картинка 9:14 или 4:5, путь относительно папки вселенной
 *   accent,      // цвет акцента (см. ACCENTS в format.js)
 *   order,       // порядок карточек в библиотеке
 *   baseUrl      // заполняет загрузчик, руками не пишем
 * }
 *
 * Новелла (story) ссылается на вселенную полем `universe` = id вселенной.
 * Пустая строка / неизвестный id → «Без вселенной» (ничего не теряется).
 *
 * Идентификатор вселенной = имя её папки в stories/. Его пишем только
 * латиницей, цифрами и дефисами — иначе сломаются пути к картинкам.
 */
import { ACCENTS } from './format.js';
import { uid } from './util.js';

export const UNIVERSE_SCHEMA = 1;
export const NO_UNIVERSE = '';
export const NO_UNIVERSE_TITLE = 'Без вселенной';
export const UNIVERSE_ORDER_DEFAULT = 100;

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Русский текст → латиница (для id и имён папок). */
export function translit(text = '') {
  return String(text).toLowerCase().split('').map((c) => (c in TRANSLIT ? TRANSLIT[c] : c)).join('');
}

/** Человеческое название → безопасный id: «Тихие пути» → «tihie-puti». */
export function slugId(text = '', prefix = 'world') {
  const slug = translit(text)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || `${prefix}-${uid('').replace(/^_/, '').slice(0, 5)}`;
}

export function createUniverse(overrides = {}) {
  const title = overrides.title || 'Новая вселенная';
  return normalizeUniverse({
    schema: UNIVERSE_SCHEMA,
    id: overrides.id || slugId(title),
    title,
    author: '',
    description: '',
    cover: '',
    accent: ACCENTS[0],
    order: UNIVERSE_ORDER_DEFAULT,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  });
}

/** Приводит вселенную к схеме. Не бросает исключений — чинит по ходу. */
export function normalizeUniverse(input) {
  const universe = input && typeof input === 'object' ? input : {};
  universe.schema = UNIVERSE_SCHEMA;
  universe.id = String(universe.id || '').trim() || slugId(universe.title);
  universe.title = String(universe.title || 'Без названия');
  universe.author = String(universe.author || '');
  universe.description = String(universe.description || '');
  universe.cover = typeof universe.cover === 'string' ? universe.cover : '';
  universe.accent = universe.accent || ACCENTS[0];
  universe.order = Number.isFinite(+universe.order) ? +universe.order : UNIVERSE_ORDER_DEFAULT;
  universe.baseUrl = typeof universe.baseUrl === 'string' ? universe.baseUrl : '';
  return universe;
}

/** Служебная «вселенная» для новелл без вселенной (в файлы не попадает). */
export function looseUniverse(novels = []) {
  return {
    schema: UNIVERSE_SCHEMA,
    id: NO_UNIVERSE,
    title: NO_UNIVERSE_TITLE,
    description: 'Новеллы, которым ещё не выбрали вселенную.',
    cover: '',
    accent: ACCENTS[0],
    order: 9999,
    baseUrl: '',
    loose: true,
    novels,
  };
}

/** Копия вселенной без служебных полей — для файла и localStorage. */
export function universeData(universe) {
  const { baseUrl, loose, novels, builtin, readOnly, ...rest } = universe;
  void baseUrl; void loose; void novels; void builtin; void readOnly;
  return rest;
}
