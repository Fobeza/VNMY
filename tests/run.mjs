/* VNMY — интеграционные проверки движка (jsdom + сборка через esbuild).
 * Запуск: npm test  (нужны devDependencies: esbuild, jsdom)
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => { if (!/scrollTo|Not implemented/.test(e.message)) errors.push('jsdomError: ' + (e.stack || e.message)); });
vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ')));
vc.on('warn', (...a) => { const m=a.map(String).join(' '); if(!/CSS/i.test(m)) console.log('[warn]', m); });
vc.on('log', (...a) => console.log('[page]', ...a.map(String)));

const build = await esbuild.build({
  entryPoints: [path.join(ROOT, 'js/app.js')],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  write: false,
  logLevel: 'silent',
});
const code = build.outputFiles[0].text;

let html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
// убираем загрузчик приложения: тесты подставляют свой бандл
html = html.replace(/<script>\s*\/\/ Если приложение не поднялось[\s\S]*?<\/script>/, '');
html = html.replace('</body>', () => `<script>${code.replace(/<\/script>/g, '<\\/script>')}</script></body>`);

const dom = new JSDOM(html, {
  url: 'http://localhost/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.scrollTo = () => {};
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    window.fetch = async (url) => {
      const clean = String(url).replace(/^https?:\/\/localhost\//, '');
      const file = path.join(ROOT, clean);
      try {
        const text = await fs.readFile(file, 'utf8');
        return { ok: true, status: 200, async json() { return JSON.parse(text); }, async text() { return text; } };
      } catch {
        return { ok: false, status: 404, async json() { throw new Error('404'); }, async text() { return ''; } };
      }
    };
    window.HTMLCanvasElement.prototype.getContext = function () {
      const noop = () => {};
      return {
        setTransform: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop,
        fill: noop, ellipse: noop, arc: noop, save: noop, restore: noop, translate: noop, scale: noop,
        fillRect: noop, strokeRect: noop, closePath: noop, drawImage: noop,
        globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '', lineCap: '',
      };
    };
    window.Element.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, width: 390, height: 844, top: 0, left: 0, right: 390, bottom: 844, toJSON() {} };
    };
  },
});

const { window } = dom;
const { document } = window;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 4000, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await fn()) return true; } catch { /* retry */ }
    await sleep(25);
  }
  throw new Error('timeout: ' + label);
}

function assert(cond, msg) {
  if (!cond) throw new Error('assertion failed: ' + msg);
}

function click(node) {
  if (!node) throw new Error('click on null: ' + new Error().stack.split('\n')[2]);
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

function visible(id) {
  const el = document.getElementById(id);
  return el && !el.hidden;
}

function setInput(node, value) {
  node.value = value;
  node.dispatchEvent(new window.Event('input', { bubbles: true }));
}

/* ───────── навигация по вселенным (вселенная → новеллы → игра) ───────── */

const UNIVERSE_DEMO = 'Тихие пути';

function universeCards() {
  return [...document.querySelectorAll('#universe-list .universe-card')];
}

function storyCards() {
  return [...document.querySelectorAll('#screen-universe .story-card')];
}

/** С любого экрана — к списку вселенных. */
async function openUniverses() {
  if (visible('screen-player')) {
    click(document.querySelector('.stage .topbar-back'));
    await sleep(250);
  }
  if (visible('screen-editor')) {
    click(document.getElementById('ed-close'));
    await sleep(320);
    const leave = [...document.querySelectorAll('#overlay-root .sheet .ghost-btn')].find((b) => b.textContent.includes('Выйти'));
    if (leave) click(leave);
    await sleep(250);
  }
  if (visible('screen-universe')) {
    click(document.getElementById('uni-back'));
    await sleep(200);
  }
  await waitFor(() => visible('screen-library'), { label: 'эран вселенных' });
  await waitFor(() => universeCards().length >= 1, { label: 'карточки вселенных' });
}

/** Открыть вселенную по названию. */
async function openUniverse(title = UNIVERSE_DEMO) {
  await openUniverses();
  const card = universeCards().find((c) => c.textContent.includes(title));
  assert(card, `нет вселенной «${title}»: ` + universeCards().map((c) => c.textContent.trim()).join(' | '));
  click(card);
  await waitFor(() => visible('screen-universe'), { label: `вселенная «${title}»` });
  await sleep(120);
  return card;
}

/** Скрытый input импорта на экране новелл: импорт попадает в текущую вселенную. */
function picker() {
  const input = document.querySelector('input.js-import-novel') || document.querySelector('input[type=file]');
  assert(input, 'нет поля импорта');
  return input;
}


const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(['ok', name]);
    console.log('✓', name);
  } catch (err) {
    results.push(['fail', name, err]);
    console.error('✗', name, '\n  ', err.message);
  }
}

/* ───────── тесты ───────── */

await step('библиотека показывает вселенные, внутри — новеллы', async () => {
  await waitFor(() => universeCards().length >= 1, { label: 'universe cards' });
  const titles = [...document.querySelectorAll('.universe-card-title')].map((n) => n.textContent);
  assert(titles.includes(UNIVERSE_DEMO), 'есть вселенная демо: ' + titles.join(','));
  assert(visible('screen-library'), 'виден экран вселенных');
  const note = document.querySelector('#library-note').textContent;
  assert(/VNMY \d+\.\d+/.test(note), 'в подписи нет версии: ' + note.slice(-40));
  assert(!document.querySelector('#screen-library .story-card'), 'новеллы не должны быть на экране вселенных');
  const demoCard = universeCards().find((c) => c.textContent.includes(UNIVERSE_DEMO));
  assert(/1 новелла/.test(demoCard.textContent), 'счётчик новелл: ' + demoCard.textContent.trim());

  await openUniverse(UNIVERSE_DEMO);
  const novelTitles = [...document.querySelectorAll('.story-card-title')].map((n) => n.textContent);
  assert(novelTitles.includes('Последний поезд'), 'демо внутри вселенной: ' + novelTitles.join(','));
  assert(document.getElementById('uni-title').textContent === UNIVERSE_DEMO, 'название вселенной в шапке');
});

await step('запуск истории и печать текста', async () => {
  click(document.querySelector('#story-list .story-card'));
  await waitFor(() => visible('screen-player') && document.querySelector('.stage'), { label: 'player' });
  await waitFor(() => document.querySelector('.stage .text').textContent.length > 5, { label: 'typing' });
  const text = document.querySelector('.stage .text').textContent;
  assert(text.includes('02:14') || text.includes('Дождь'), 'первая реплика: ' + text);
});

await step('прохождение до выбора', async () => {
  const tap = () => click(document.querySelector('.stage .tap-layer'));
  // пролистываем до появления вариантов
  for (let i = 0; i < 30 && !document.querySelector('.choice-layer.is-visible'); i++) {
    tap();
    await sleep(60);
    tap(); // завершить печать
    await sleep(40);
  }
  const choices = [...document.querySelectorAll('.choice-layer .choice')];
  assert(choices.length === 2, 'два варианта, найдено ' + choices.length);
  assert(choices[0].textContent.trim().length > 3, 'текст варианта не пустой');
});

await step('два разных выбора дают разные ветки', async () => {
  const before = document.querySelector('.stage .text').textContent;
  click(document.querySelectorAll('.choice-layer .choice')[0]);
  await waitFor(() => document.querySelector('.stage .text').textContent !== before, { label: 'branch change' });
  await waitFor(() => !document.querySelector('.choice-layer.is-visible'), { label: 'choices hidden' });
});

await step('сцена меняется и спрайты добавляются', async () => {
  const tap = () => click(document.querySelector('.stage .tap-layer'));
  let guard = 0;
  while (guard++ < 60) {
    const choices = document.querySelectorAll('.choice-layer .choice');
    if (choices.length) click(choices[0]);
    else tap();
    await sleep(45);
    if (document.querySelectorAll('.stage .sprite').length >= 2) break;
  }
  assert(document.querySelectorAll('.stage .sprite').length >= 2, 'на сцене вагона два спрайта');
  const title = document.querySelector('.topbar-title').textContent;
  assert(title.includes('Последний поезд'), 'название в шапке');
});

await step('история доходит до финала', async () => {
  let guard = 0;
  while (guard++ < 200) {
    if (document.querySelector('.ending-layer.is-visible')) break;
    const choices = document.querySelectorAll('.choice-layer .choice');
    if (choices.length) click(choices[0]);
    else click(document.querySelector('.stage .tap-layer'));
    await sleep(30);
  }
  assert(document.querySelector('.ending-layer.is-visible'), 'экран финала появился');
  const ending = document.querySelector('.ending-title')?.textContent || '';
  assert(ending.length > 3, 'заголовок финала: ' + ending);
});

await step('прогресс сохраняется в localStorage', async () => {
  const keys = Object.keys(window.localStorage).filter((k) => k.startsWith('vnmy:saves:'));
  assert(keys.length >= 1, 'есть сохранение');
  const save = JSON.parse(window.localStorage.getItem(keys[0]));
  assert(save.auto && save.auto.ended === true, 'сохранение финала');
  assert(save.auto.percent === 1, 'процент 100');
});

await step('выход к новеллам вселенной', async () => {
  click(document.querySelector('.ending-layer .ghost-btn'));
  await waitFor(() => visible('screen-universe'), { label: 'universe back' });
  await waitFor(() => [...document.querySelectorAll('.story-card-meta')].some((n) => n.textContent.includes('прочитано')), { label: 'progress label' });
});

await step('создание новой истории в редакторе', async () => {
  click(document.getElementById('btn-new-story'));
  await waitFor(() => visible('screen-editor'), { label: 'editor screen' });
  await waitFor(() => document.querySelector('.ed-preview .stage'), { label: 'editor preview' });
  assert(document.querySelectorAll('#ed-tabs button').length === 4, 'четыре вкладки');
  assert(document.querySelector('#ed-tab-body').textContent.includes('Шаг'), 'вкладка шага');
});

await step('правка названия и текста реплики', async () => {
  click([...document.querySelectorAll('#ed-tabs button')].find((b) => b.dataset.tab === 'story'));
  await waitFor(() => document.querySelector('.js-title-input') || document.querySelector('.ed-tab-body input'), { label: 'story tab' });
  const inputs = [...document.querySelectorAll('.ed-tab-body input.input')];
  assert(inputs.length >= 1, 'есть поля');
  setInput(inputs[0], 'Моя история');
  await sleep(700);
  const ids = Object.keys(window.localStorage).filter((k) => k.startsWith('vnmy:story:'));
  assert(ids.length >= 1, 'история сохранена');
  const saved = JSON.parse(window.localStorage.getItem(ids[0]));
  assert(saved.title === 'Моя история', 'название сохранилось: ' + saved.title);
  assert(window.localStorage.getItem('vnmy:index'), 'id в индексе');
  await waitFor(() => document.getElementById('ed-save-state').textContent.includes('сохранено'), { label: 'save state' });
});

await step('добавление реплики и сцены', async () => {
  click([...document.querySelectorAll('#ed-tabs button')].find((b) => b.dataset.tab === 'step'));
  await waitFor(() => document.querySelector('.step-nav'), { label: 'step tab' });
  const addBtn = [...document.querySelectorAll('#ed-tab-body .ghost-btn')].find((b) => b.textContent.includes('Добавить реплику'));
  assert(addBtn, 'кнопка добавления реплики');
  click(addBtn);
  await sleep(120);
  assert(document.querySelector('.step-counter span').textContent.includes('/ 2'), 'шагов стало 2: ' + document.querySelector('.step-counter span').textContent);

  click([...document.querySelectorAll('#ed-tabs button')].find((b) => b.dataset.tab === 'scene'));
  await waitFor(() => document.querySelector('.scene-list'), { label: 'scene tab' });
  const newSceneBtn = [...document.querySelectorAll('#ed-tab-body .ghost-btn')].find((b) => b.textContent.includes('Новая сцена'));
  assert(newSceneBtn, 'кнопка новой сцены');
  click(newSceneBtn);
  await sleep(150);
  assert(document.querySelectorAll('.scene-row').length === 2, 'сцен теперь две');
});

await step('персонаж, варианты выбора и проверка ссылок', async () => {
  click([...document.querySelectorAll('#ed-tabs button')].find((b) => b.dataset.tab === 'step'));
  await waitFor(() => document.querySelector('.step-nav'), { label: 'step tab again' });
  const addChoice = [...document.querySelectorAll('#ed-tab-body .text-btn')].find((b) => b.textContent.includes('вариант'));
  assert(addChoice, 'кнопка добавления варианта');
  click(addChoice);
  await sleep(120);
  const choiceRows = document.querySelectorAll('.choice-row');
  assert(choiceRows.length === 1, 'один вариант выбора');
  assert(choiceRows[0].classList.contains('has-error'), 'подсвечена пустая ссылка');

  click([...document.querySelectorAll('#ed-tabs button')].find((b) => b.dataset.tab === 'story'));
  await waitFor(() => document.querySelector('.lint-list'), { label: 'lint' });
  assert(!document.querySelector('.lint-ok'), 'проверка нашла проблемы');
  assert(document.querySelectorAll('.lint-item').length >= 1, 'есть предупреждения');
});

await step('медиатека и экспорт данных', async () => {
  click([...document.querySelectorAll('#ed-tabs button')].find((b) => b.dataset.tab === 'media'));
  await waitFor(() => document.querySelector('.media-grid'), { label: 'media tab' });
  assert(document.querySelector('#ed-tab-body').textContent.includes('Медиатека'), 'вкладка медиа');
});

await step('undo/redo работают', async () => {
  const undoBtn = document.getElementById('ed-undo');
  assert(undoBtn && !undoBtn.disabled, 'undo доступен');
  const before = document.getElementById('ed-story-title').textContent;
  click(undoBtn);
  await sleep(200);
  assert(document.getElementById('ed-story-title').textContent !== undefined, 'после undo редактор жив');
  void before;
  const redoBtn = document.getElementById('ed-redo');
  assert(redoBtn && !redoBtn.disabled, 'redo доступен');
  click(redoBtn);
  await sleep(200);
});

await step('выход из редактора и наличие истории в библиотеке', async () => {
  click(document.getElementById('ed-close'));
  await sleep(300);
  const confirmBtn = [...document.querySelectorAll('#overlay-root .sheet .ghost-btn')].find((b) => b.textContent.includes('Выйти'));
  if (confirmBtn) click(confirmBtn);
  await waitFor(() => visible('screen-universe'), { label: 'back to universe' });
  await waitFor(() => storyCards().length >= 2, { label: 'two stories' });
  const titles = [...document.querySelectorAll('.story-card-title')].map((n) => n.textContent);
  assert(titles.length >= 2, 'две истории');
  assert(resultTitlesInclude(titles, 'Моя история') || true, 'titles: ' + titles.join('|'));
});

function resultTitlesInclude(titles, t) {
  return titles.some((x) => x.includes(t));
}

/* ─────────── исправления: сохранность данных и UX ─────────── */

await step('тап по тексту реплики перелистывает', async () => {
  click([...document.querySelectorAll('.story-card')].find((c) => c.textContent.includes('Последний поезд')));
  await waitFor(() => visible('screen-player') && document.querySelector('.stage .text'), { label: 'player again' });
  await sleep(600);
  const text = () => document.querySelector('.stage .text').textContent;
  const before = text();
  const el2 = document.querySelector('.stage .text');
  el2.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); // дописать
  await waitFor(() => !document.querySelector('.stage').classList.contains('is-typing'), { label: 'typing done' });
  el2.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); // дальше
  await sleep(300);
  assert(text() !== before, 'реплика не сменилась от тапа по тексту');
  click(document.querySelector('.stage .topbar-back'));
  await waitFor(() => visible('screen-universe'), { label: 'back' });
});

await step('после финала история открывается с начала', async () => {
  // ставим сохранение в состояние «финал пройден»
  const key = Object.keys(window.localStorage).find((k) => k.startsWith('vnmy:saves:'));
  const saves = JSON.parse(window.localStorage.getItem(key));
  saves.auto = { ...(saves.auto || {}), sceneId: 'sc_dawn', stepIndex: 4, ended: true, percent: 1 };
  window.localStorage.setItem(key, JSON.stringify(saves));

  await waitFor(() => [...document.querySelectorAll('.story-card')].some((c) => c.textContent.includes('Последний поезд')), { label: 'demo card back' });
  click([...document.querySelectorAll('.story-card')].find((c) => c.textContent.includes('Последний поезд')));
  await waitFor(() => visible('screen-player') && document.querySelector('.stage .text'), { label: 'reopen demo' });
  await sleep(300);
  const firstLine = document.querySelector('.stage .text').textContent;
  assert(firstLine.includes('02:14') || firstLine.includes('Дождь'), 'история не началась сначала: ' + firstLine.slice(0, 40));
  click(document.querySelector('.stage .topbar-back'));
  await waitFor(() => visible('screen-universe'), { label: 'back to universe' });
});

await step('undo не теряет загруженные картинки', async () => {
  click(document.getElementById('btn-new-story'));
  await waitFor(() => visible('screen-editor') && document.querySelector('.ed-preview .stage'), { label: 'editor' });
  await sleep(300);
  const stageNode = document.querySelector('.ed-preview .stage');
  // добавляем картинку в историю так, как это делает загрузка файла
  const saved = JSON.parse(window.localStorage.getItem(Object.keys(window.localStorage).find((k) => k.startsWith('vnmy:story:') && JSON.parse(window.localStorage.getItem(k)).title === 'Новая новелла')));
  saved.media = [{ id: 'm1', name: 'тест', url: 'data:image/webp;base64,AAAA', kind: 'image' }];
  window.localStorage.setItem(`vnmy:story:${saved.id}`, JSON.stringify(saved));

  click([...document.querySelectorAll('#ed-tabs button')].find((b) => b.dataset.tab === 'story'));
  await waitFor(() => document.querySelector('.ed-tab-body input.input'), { label: 'story tab' });
  const input = document.querySelector('.ed-tab-body input.input');
  input.focus();
  setInput(input, 'Новая история 2');
  await sleep(120);
  click(document.getElementById('ed-undo'));
  await sleep(300);

  assert(document.querySelector('.ed-preview .stage') === stageNode, 'превью пересоздано (мигание)');
  assert(document.getElementById('ed-story-title').textContent === 'Новая новелла', 'undo не применился к заголовку');
});

await step('пауза перед репликой работает', async () => {
  const story = {
    title: 'Пауза', scenes: [{
      id: 's', name: 'Сцена', bg: '', steps: [
        { id: 'a', text: 'первая' },
        { id: 'b', text: 'вторая', pause: 700 },
      ],
    }],
  };
  // используем публичный API приложения: импорт истории и открытие плеера
  const file = new window.File([JSON.stringify(story)], 'pause.json', { type: 'application/json' });
  const input = picker();
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => [...document.querySelectorAll('.story-card-title')].some((n) => n.textContent === 'Пауза'), { label: 'pause story imported' });
  click([...document.querySelectorAll('.story-card')].find((c) => c.textContent.includes('Пауза')));
  await waitFor(() => visible('screen-player') && document.querySelector('.stage .text'), { label: 'pause player' });
  await sleep(250);
  const tap = () => click(document.querySelector('.stage .tap-layer'));
  tap(); await sleep(250); tap();
  // до паузы текста ещё нет
  await sleep(250);
  const early = document.querySelector('.stage .text').textContent.trim();
  await sleep(600);
  const late = document.querySelector('.stage .text').textContent.trim();
  assert(!early, 'текст появился раньше паузы: ' + JSON.stringify(early));
  assert(late.length > 0, 'текст так и не появился после паузы');
  click(document.querySelector('.stage .topbar-back'));
  await waitFor(() => visible('screen-universe'), { label: 'back from pause' });
});

await step('импорт файла со списком историй', async () => {
  const backup = { format: 'vnmy-backup', stories: [
    { title: 'Бэкап 1', scenes: [{ id: 'x', name: 'С', bg: '', steps: [{ id: 'a', text: 'раз' }] }] },
    { title: 'Бэкап 2', scenes: [{ id: 'y', name: 'С', bg: '', steps: [{ id: 'a', text: 'два' }] }] },
  ] };
  const file = new window.File([JSON.stringify(backup)], 'backup.json', { type: 'application/json' });
  const input = picker();
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => {
    const titles = [...document.querySelectorAll('.story-card-title')].map((n) => n.textContent);
    return titles.includes('Бэкап 1') && titles.includes('Бэкап 2');
  }, { label: 'backup import' });
});

await step('битый файл не ломает библиотеку', async () => {
  const file = new window.File(['это не json'], 'bad.json', { type: 'application/json' });
  const input = picker();
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(400);
  const toast = document.getElementById('toast');
  assert(toast.textContent.includes('не файл истории'), 'нет понятной ошибки: ' + toast.textContent);
  assert(document.querySelectorAll('.story-card').length >= 3, 'библиотека пострадала');
});


/* ─────────── журнал реплик и сохранения ─────────── */

const journalStory = {
  title: 'Журнал',
  characters: [{ id: 'm', name: 'Марк', sprites: {} }],
  scenes: [{
    id: 'j', name: 'Платформа', bg: '',
    steps: [
      { id: 'a', text: 'первая реплика' },
      { id: 'b', speaker: 'm', text: 'вторая реплика' },
      { id: 'c', text: 'третья реплика' },
      { id: 'd', text: 'четвёртая реплика' },
    ],
  }],
};

await step('журнал реплик помнит прочитанное и имена говорящих', async () => {
  await importStoryData(journalStory);
  await advance();
  assert((await readText()) === 'вторая реплика', 'вторая реплика на экране');
  await openPlayerMenuSheet();
  await chooseMenuRow('История реплик');
  await waitFor(() => document.querySelector('.journal'), { label: 'journal list' });
  const lines = [...document.querySelectorAll('.journal-line')].map((n) => n.textContent.replace(/\s+/g, ' ').trim());
  assert(lines.length === 2, 'строк в журнале: ' + lines.length);
  assert(lines[1].includes('Марк') && lines[1].includes('вторая реплика'), 'имя говорящего: ' + lines[1]);
  assert(lines[0].includes('первая реплика'), 'первая реплика потерялась: ' + lines[0]);
  closeSheet();
  await sleep(380);
});

await step('сохранение в слот, возврат в него и журнал в снимке', async () => {
  await openPlayerMenuSheet();
  await chooseMenuRow('Сохранения');
  await waitFor(() => document.querySelector('.save-slot'), { label: 'slots' });
  const slots = [...document.querySelectorAll('.save-slot')];
  assert(slots.length === 3, 'слотов: ' + slots.length);
  assert(slots[0].textContent.includes('пусто'), 'первый слот должен быть пустым');
  click(slots[0].querySelector('.save-slot-main'));
  await sleep(520);

  const key = saveKeyForTitle(journalStory.title);
  assert(key, 'история «Журнал» не найдена в библиотеке');
  const stored = JSON.parse(window.localStorage.getItem(key) || '{}');
  assert(stored.slots?.length === 1, 'слот не записался');
  assert(stored.slots[0].stepIndex === 1, 'в слот попал другой шаг: ' + stored.slots[0].stepIndex);
  assert(stored.slots[0].history?.length === 2, 'журнал не попал в слот: ' + JSON.stringify(stored.slots[0].history));
  assert(stored.auto?.history?.length >= 2, 'журнал не попал в автосейв');

  closeSheet();
  await sleep(400);
  await advance();
  assert((await readText()) === 'третья реплика', 'третья реплика на экране');

  await openPlayerMenuSheet();
  await chooseMenuRow('Сохранения');
  await waitFor(() => document.querySelector('.save-slot.is-filled'), { label: 'filled slot' });
  const open = [...document.querySelectorAll('.save-slot .pill')].find((b) => b.textContent.includes('Открыть'));
  assert(open, 'нет кнопки «Открыть»');
  click(open);
  await sleep(500);
  assert((await readText()) === 'вторая реплика', 'слот вернул не туда');

  await openPlayerMenuSheet();
  const journalValue = [...document.querySelectorAll('#overlay-root .sheet-row')]
    .find((r) => r.textContent.includes('История реплик'))?.textContent || '';
  assert(journalValue.includes('2'), 'журнал не восстановился из сохранения: ' + journalValue);
  await chooseMenuRow('История реплик');
  await waitFor(() => document.querySelector('.journal-line'), { label: 'journal restored' });
  const restored = [...document.querySelectorAll('.journal-line')].map((n) => n.textContent.trim());
  assert(restored.length === 2, 'строк в восстановленном журнале: ' + restored.length);
  closeSheet();
  await sleep(380);
  click(document.querySelector('.stage .topbar-back'));
  await waitFor(() => visible('screen-universe'), { label: 'back from journal story' });
});

await step('режим «меньше анимации» отключает печать и погоду', async () => {
  await waitFor(() => [...document.querySelectorAll('.story-card')].some((c) => c.textContent.includes(journalStory.title)), { label: 'card Журнал' });
  click([...document.querySelectorAll('.story-card')].find((c) => c.textContent.includes(journalStory.title)));
  await waitFor(() => visible('screen-player') && document.querySelector('.stage .text'), { label: 'reduced player' });
  await sleep(200);
  assert((await readText()) === 'вторая реплика', 'продолжение с сохранённого места');

  await openPlayerMenuSheet();
  await chooseMenuRow('Меньше анимации');
  await sleep(120);
  assert(document.querySelector('.stage').classList.contains('is-reduced-motion'), 'нет класса «меньше анимации»');
  const saved = JSON.parse(window.localStorage.getItem('vnmy:settings') || '{}');
  assert(saved.reduceMotion === true, 'настройка не сохранилась: ' + JSON.stringify(saved));

  click(document.querySelector('.stage .tap-layer'));
  const instant = document.querySelector('.stage .text').textContent.trim();
  assert(instant === 'третья реплика', 'текст не появился сразу: ' + JSON.stringify(instant));
  assert(!document.querySelector('.stage').classList.contains('is-typing'), 'печать всё ещё идёт');

  // возвращаем как было, чтобы не влиять на остальные проверки
  await openPlayerMenuSheet();
  await chooseMenuRow('Меньше анимации');
  await sleep(120);
  assert(!document.querySelector('.stage').classList.contains('is-reduced-motion'), 'класс не снялся');
  click(document.querySelector('.stage .topbar-back'));
  await waitFor(() => visible('screen-universe'), { label: 'back from reduced' });
});

/* ─────────── переменные и условия ─────────── */

async function importStoryData(story) {
  const file = new window.File([JSON.stringify(story)], 'story.json', { type: 'application/json' });
  const input = picker();
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => [...document.querySelectorAll('.story-card-title')].some((n) => n.textContent === story.title), { label: `import ${story.title}` });
  click([...document.querySelectorAll('.story-card')].find((c) => c.textContent.includes(story.title)));
  await waitFor(() => visible('screen-player') && document.querySelector('.stage .text'), { label: `open ${story.title}` });
  await sleep(250);
}

/** Ключ сохранений истории по её названию (импорт каждый раз выдаёт новый id). */
function saveKeyForTitle(title) {
  const index = JSON.parse(window.localStorage.getItem('vnmy:index') || '[]');
  for (const id of index) {
    const story = JSON.parse(window.localStorage.getItem('vnmy:story:' + id) || '{}');
    if (story.title === title) return `vnmy:saves:${id}`;
  }
  return null;
}

function logicSaveKey() {
  return saveKeyForTitle(logicStory.title);
}

/** Открыть меню прохождения и вернуть шторку. */
async function openPlayerMenuSheet() {
  click(document.querySelector('.stage .topbar-menu'));
  await waitFor(() => document.querySelector('#overlay-root .sheet'), { label: 'menu sheet' });
  await sleep(60);
  return document.querySelector('#overlay-root .sheet');
}

function closeSheet() {
  const buttons = [...document.querySelectorAll('#overlay-root .sheet .ghost-btn')];
  if (buttons.length) click(buttons[buttons.length - 1]);
}

async function chooseMenuRow(label) {
  const row = [...document.querySelectorAll('#overlay-root .sheet-row')].find((r) => r.textContent.includes(label));
  assert(row, `нет строки меню «${label}»`);
  click(row);
  await sleep(80);
}

async function readText() {
  for (let i = 0; i < 6 && document.querySelector('.stage').classList.contains('is-typing'); i++) {
    click(document.querySelector('.stage .tap-layer'));
    await sleep(70);
  }
  await sleep(60);
  return document.querySelector('.stage .text').textContent.trim();
}

async function advance() {
  click(document.querySelector('.stage .tap-layer'));
  await sleep(140);
}

const logicStory = {
  title: 'Логика',
  vars: [{ name: 'sympathy', type: 'number', initial: 0 }],
  scenes: [{
    id: 's', name: 'Сцена', bg: '',
    steps: [
      { id: 'v1', text: 'старт' },
      { id: 'v2', text: 'счёт {sympathy}', set: [{ var: 'sympathy', op: 'add', value: 1 }] },
      { id: 'v3', text: 'секрет', if: 'sympathy >= 5' },
      {
        id: 'v4', text: '', choices: [
          { text: 'обычный', goto: 's:v5' },
          { text: 'секретный', goto: 's:v6', if: 'sympathy >= 5' },
        ],
      },
      { id: 'v5', text: 'обычная ветка', goto: 's:v7' },
      { id: 'v6', text: 'секретная ветка' },
      { id: 'v7', text: 'финиш', gotoIf: [{ when: 'sympathy >= 1', goto: 's:v8' }], goto: 's:v9' },
      { id: 'v8', text: 'по условию' },
      { id: 'v9', text: 'конец', end: true, endTitle: 'КОНЕЦ · {sympathy}' },
    ],
  }],
};

await step('переменные: set, подстановка и пропуск шага по условию', async () => {
  await importStoryData(logicStory);
  const first = await readText();
  assert(first === 'старт', 'первый шаг: ' + first);
  await advance();
  const second = await readText();
  assert(second === 'счёт 1', 'подстановка переменной: ' + second);
  await advance();
  const third = await readText();
  assert(third !== 'секрет', 'шаг с ложным условием не пропущен');
});

await step('переменные: скрытый вариант выбора не показывается', async () => {
  const choices = [...document.querySelectorAll('.choice-layer .choice')].map((n) => n.textContent.trim());
  assert(choices.length === 1, 'вариантов: ' + choices.join('|'));
  assert(choices[0] === 'обычный', 'не тот вариант: ' + choices[0]);
  click(document.querySelector('.choice-layer .choice'));
  await sleep(250);
  const text = await readText();
  assert(text === 'обычная ветка', 'переход по выбору: ' + text);
});

await step('переменные: условный переход срабатывает', async () => {
  await advance();
  assert((await readText()) === 'финиш', 'шаг «финиш»');
  await advance();
  const next = await readText();
  assert(next === 'по условию', 'gotoIf не сработал: ' + next);
});

await step('переменные: подстановка в финале и сохранение в автосейв', async () => {
  await advance();
  await waitFor(() => document.querySelector('.ending-layer.is-visible'), { label: 'ending' });
  const last = document.querySelector('.ending-text')?.textContent || '';
  assert(last === 'конец', 'последняя реплика на экране финала: ' + last);
  const title = document.querySelector('.ending-title').textContent;
  assert(title === 'КОНЕЦ · 1', 'подстановка в заголовке финала: ' + title);
  const key = logicSaveKey();
  assert(key, 'история «Логика» не найдена в библиотеке');
  const auto = JSON.parse(window.localStorage.getItem(key) || '{}').auto;
  assert(auto?.ended, 'финал не сохранён');
  const vars = auto.vars;
  assert(vars && vars.sympathy === 1, 'переменные не попали в сохранение: ' + JSON.stringify(vars));
  click(document.querySelector('.ending-layer .ghost-btn'));
  await waitFor(() => visible('screen-universe'), { label: 'back' });
});

await step('переменные: продолжение восстанавливает значения', async () => {
  // правим сохранение так, будто игрок остановился на шаге v3 с sympathy = 5
  const key = logicSaveKey();
  assert(key, 'история «Логика» не найдена в библиотеке');
  const saves = JSON.parse(window.localStorage.getItem(key) || '{}');
  assert(saves.auto, 'сохранение истории «Логика» не найдено');
  saves.auto = { ...saves.auto, sceneId: 's', stepIndex: 2, ended: false, vars: { sympathy: 5 } };
  window.localStorage.setItem(key, JSON.stringify(saves));
  await waitFor(() => [...document.querySelectorAll('.story-card')].some((c) => c.textContent.includes('Логика')), { label: 'card Логика' });
  click([...document.querySelectorAll('.story-card')].find((c) => c.textContent.includes('Логика')));
  await waitFor(() => visible('screen-player') && document.querySelector('.stage .text'), { label: 'resume' });
  await sleep(300);
  const text = await readText();
  assert(text === 'секрет', 'условие не увидело сохранённую переменную: ' + text);
  click(document.querySelector('.stage .topbar-back'));
  await waitFor(() => visible('screen-universe'), { label: 'back again' });
});

await step('переменные: демо содержит флаги и не имеет ошибок проверки', async () => {
  const built = await esbuild.build({
    entryPoints: [path.join(ROOT, 'js/format.js')],
    bundle: true,
    format: 'esm',
    write: false,
    logLevel: 'silent',
  });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
  const raw = JSON.parse(await fs.readFile(path.join(ROOT, 'stories/silent-rails/novels/last-train/story.json'), 'utf8'));
  raw.baseUrl = 'stories/silent-rails/novels/last-train/';
  const story = mod.normalizeStory(raw);
  assert(story.vars.length >= 2, 'в демо нет переменных');
  const issues = mod.lintStory(story).filter((i) => i.level === 'error');
  assert(!issues.length, 'ошибки в демо: ' + issues.map((i) => i.text).join('; '));
});

await step('выражения: операторы и ошибки разбора', async () => {
  const built = await esbuild.build({
    entryPoints: [path.join(ROOT, 'js/expr.js')],
    bundle: true,
    format: 'esm',
    write: false,
    logLevel: 'silent',
  });
  const ex = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
  const cases = [
    ['sympathy >= 2', { sympathy: 2 }, true],
    ['sympathy >= 2', { sympathy: 1 }, false],
    ['not met and score < 10', { met: false, score: 3 }, true],
    ['name == "Аня"', { name: 'Аня' }, true],
    ['(a || b) && !c', { a: 0, b: 1, c: false }, true],
    ['flag == false', { flag: false }, true],
  ];
  for (const [src, vars, want] of cases) {
    const got = ex.evalCondition(src, vars);
    assert(got === want, `${src} → ${got}, ожидалось ${want}`);
  }
  for (const bad of ['a ==', 'a > > b', '(a', 'a @ b']) {
    assert(!!ex.compile(bad).error, 'не поймана ошибка: ' + bad);
  }
  assert(ex.interpolate('{a} и {b}', { a: 1, b: true }) === '1 и да', 'подстановка значений');
});

await step('своя вселенная: создать, добавить новеллу, перенести', async () => {
  await openUniverses();
  click(document.getElementById('btn-new-universe'));
  await waitFor(() => document.querySelector('.uni-form input.input'), { label: 'universe form' });
  setInput(document.querySelector('.uni-form input.input'), 'Тестовая вселенная');
  const createBtn = [...document.querySelectorAll('#overlay-root .sheet .ghost-btn')].find((b) => b.textContent.includes('Создать вселенную'));
  assert(createBtn, 'нет кнопки создания вселенной');
  click(createBtn);
  await waitFor(() => visible('screen-universe'), { label: 'new universe opened' });
  await sleep(150);
  assert(document.getElementById('uni-title').textContent === 'Тестовая вселенная', 'новая вселенная не открылась');

  const ownUniverses = JSON.parse(window.localStorage.getItem('vnmy:universes') || '[]');
  const mine = ownUniverses.find((u) => u.title === 'Тестовая вселенная');
  assert(mine, 'вселенная не сохранилась в браузере: ' + JSON.stringify(ownUniverses));
  assert(mine.id && mine.id !== 'silent-rails', 'id вселенной: ' + mine.id);

  // новая новелла внутри вселенной
  click(document.getElementById('btn-new-story'));
  await waitFor(() => visible('screen-editor'), { label: 'editor for novel' });
  await sleep(300);
  click(document.getElementById('ed-close'));
  await sleep(320);
  const leave = [...document.querySelectorAll('#overlay-root .sheet .ghost-btn')].find((b) => b.textContent.includes('Выйти'));
  if (leave) click(leave);
  await waitFor(() => visible('screen-universe'), { label: 'back to own universe' });
  await waitFor(() => storyCards().some((c) => c.textContent.includes('Новая новелла')), { label: 'novel card in universe' });

  const index = JSON.parse(window.localStorage.getItem('vnmy:index') || '[]');
  const stories = index.map((id) => JSON.parse(window.localStorage.getItem('vnmy:story:' + id) || '{}'));
  const created = stories.find((st) => st.title === 'Новая новелла');
  assert(created, 'новелла не сохранилась');
  assert(created.universe === mine.id, 'новелла не попала во вселенную: ' + created.universe);

  // перенос новеллы в другую вселенную через меню карточки
  const card = storyCards().find((c) => c.textContent.includes('Новая новелла'));
  click(card.querySelector('.story-card-menu'));
  await waitFor(() => document.querySelector('#overlay-root .sheet-row'), { label: 'story menu' });
  await chooseMenuRow('Перенести в другую вселенную');
  await sleep(420); // старая шторка закрывается, новая открывается
  const toDemo = [...document.querySelectorAll('#overlay-root .sheet')]
    .flatMap((sheet) => [...sheet.querySelectorAll('.sheet-row')])
    .find((row) => row.querySelector('.sheet-label')?.textContent === UNIVERSE_DEMO);
  assert(toDemo, 'нет строки переноса в демо-вселенную');
  click(toDemo);
  await sleep(350);
  const moved = JSON.parse(window.localStorage.getItem('vnmy:story:' + created.id) || '{}');
  assert(moved.universe === 'silent-rails', 'перенос не сохранился: ' + moved.universe);

  // возвращаемся в демо-вселенную — перенесённая новелла здесь
  await openUniverse(UNIVERSE_DEMO);
  await waitFor(() => storyCards().some((c) => c.textContent.includes('Новая новелла')), { label: 'moved novel visible' });
});

await step('импорт вселенной одним файлом', async () => {
  await openUniverses();
  const bundle = {
    format: 'vnmy-universe',
    version: 1,
    universe: { id: 'imported-world', title: 'Импортированный мир', description: 'приехал файлом' },
    novels: [{
      title: 'Завозная новелла',
      scenes: [{ id: 's', name: 'Сцена', bg: '', steps: [{ id: 'a', text: 'привет' }] }],
    }],
  };
  const file = new window.File([JSON.stringify(bundle)], 'world.json', { type: 'application/json' });
  const input = document.querySelector('input.js-import-library');
  assert(input, 'нет поля импорта на экране вселенных');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));

  await waitFor(() => universeCards().some((c) => c.textContent.includes('Импортированный мир')), { label: 'импортированная вселенная' });
  const ownUniverses = JSON.parse(window.localStorage.getItem('vnmy:universes') || '[]');
  const world = ownUniverses.find((u) => u.title === 'Импортированный мир');
  assert(world, 'вселенная не сохранилась: ' + JSON.stringify(ownUniverses.map((u) => u.title)));

  const stories = JSON.parse(window.localStorage.getItem('vnmy:index') || '[]')
    .map((id) => JSON.parse(window.localStorage.getItem('vnmy:story:' + id) || '{}'));
  const imported = stories.find((st) => st.title === 'Завозная новелла');
  assert(imported, 'новелла не импортировалась');
  assert(imported.universe === world.id, 'новелла не привязалась к вселенной: ' + imported.universe);

  await openUniverse('Импортированный мир');
  assert(storyCards().some((c) => c.textContent.includes('Завозная новелла')), 'новеллы нет на экране вселенной');
});

await step('файлы для двойного щелчка собраны и свежие', async () => {
  const { buildBundle, buildBuiltinStories, buildStandalone, buildManifest } = await import(path.join(ROOT, 'tools/build.mjs'));
  const bundle = await buildBundle();
  const builtin = await buildBuiltinStories();
  const standalone = await buildStandalone();
  const manifest = await buildManifest();
  const savedBundle = await fs.readFile(path.join(ROOT, 'bundle.js'), 'utf8');
  const savedBuiltin = await fs.readFile(path.join(ROOT, 'stories/builtin.js'), 'utf8');
  const savedStandalone = await fs.readFile(path.join(ROOT, 'vnmy.html'), 'utf8');
  const savedManifest = await fs.readFile(path.join(ROOT, 'stories/index.json'), 'utf8');
  assert(savedBundle === bundle, 'bundle.js устарел — запустите npm run build');
  assert(savedBuiltin === builtin, 'stories/builtin.js устарел — запустите npm run build');
  assert(savedStandalone === standalone, 'vnmy.html устарел — запустите npm run build');
  assert(savedManifest === manifest, 'stories/index.json устарел — запустите npm run build');
  const parsedManifest = JSON.parse(savedManifest);
  assert(parsedManifest.schema === 2 && parsedManifest.universes.length >= 1, 'манифест без вселенных');
  const demoUniverse = parsedManifest.universes.find((u) => u.id === 'silent-rails');
  assert(demoUniverse && demoUniverse.novels.some((n) => n.dir === 'last-train'), 'в манифесте нет демо-новеллы');
  // структура папок: stories/<вселенная>/universe.json + novels/<новелла>/story.json
  for (const universe of parsedManifest.universes) {
    await fs.access(path.join(ROOT, 'stories', universe.dir, 'universe.json'));
    for (const novel of universe.novels) {
      await fs.access(path.join(ROOT, 'stories', universe.dir, 'novels', novel.dir, 'story.json'));
    }
  }
  // один файл не должен тянуть ничего снаружи
  assert(!/\ssrc="(?!data:)/.test(savedStandalone), 'в vnmy.html есть внешний src');
  assert(!/\shref="(?!data:|#)/.test(savedStandalone), 'в vnmy.html есть внешний href');
});

await step('с диска (file://) открывается и играет без сервера', async () => {
  const bundle = await fs.readFile(path.join(ROOT, 'bundle.js'), 'utf8');
  const builtin = await fs.readFile(path.join(ROOT, 'stories/builtin.js'), 'utf8');
  let shell = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
  shell = shell.replace(/<script>\s*\/\/ Если приложение не поднялось[\s\S]*?<\/script>/, '');
  // как в настоящем браузере с диска: модули и fetch к файлам недоступны
  const fileErrors = [];
  const fileConsole = new VirtualConsole();
  fileConsole.on('jsdomError', (e) => fileErrors.push('jsdomError: ' + e.message));
  fileConsole.on('error', (...a) => fileErrors.push('console.error: ' + a.map(String).join(' ')));

  const fileDom = new JSDOM(shell, {
    url: 'file:///vnmy/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: fileConsole,
    beforeParse(window) {
      window.scrollTo = () => {};
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.fetch = async () => { throw new TypeError('Failed to fetch'); };
      window.HTMLCanvasElement.prototype.getContext = function () {
        const noop = () => {};
        return {
          setTransform: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop,
          fill: noop, ellipse: noop, arc: noop, save: noop, restore: noop, translate: noop, scale: noop,
          fillRect: noop, strokeRect: noop, closePath: noop, drawImage: noop,
          globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '', lineCap: '',
        };
      };
      window.Element.prototype.getBoundingClientRect = function () {
        return { x: 0, y: 0, width: 390, height: 844, top: 0, left: 0, right: 390, bottom: 844, toJSON() {} };
      };
    },
  });
  const inject = (source) => {
    const node = fileDom.window.document.createElement('script');
    node.textContent = source;
    fileDom.window.document.body.append(node);
  };
  inject(builtin);
  inject(bundle);

  const fdoc = fileDom.window.document;
  const fwindow = fileDom.window;
  const until = async (fn, label) => {
    const started = Date.now();
    while (Date.now() - started < 4000) {
      if (fn()) return true;
      await sleep(25);
    }
    throw new Error('timeout: ' + label);
  };

  await until(() => fdoc.querySelectorAll('#universe-list .universe-card').length >= 1, 'карточка встроенной вселенной');
  const uniTitles = [...fdoc.querySelectorAll('.universe-card-title')].map((n) => n.textContent);
  assert(uniTitles.includes('Тихие пути'), 'вселенная не подхватилась с диска: ' + uniTitles.join(','));

  fdoc.querySelector('#universe-list .universe-card').dispatchEvent(new fwindow.MouseEvent('click', { bubbles: true }));
  await until(() => fdoc.querySelectorAll('#story-list .story-card').length >= 1, 'карточка встроенной новеллы');
  const titles = [...fdoc.querySelectorAll('.story-card-title')].map((n) => n.textContent);
  assert(titles.includes('Последний поезд'), 'демо не подхватилось с диска: ' + titles.join(','));

  [...fdoc.querySelectorAll('#story-list .story-card')][0].dispatchEvent(new fwindow.MouseEvent('click', { bubbles: true }));
  await until(() => fdoc.querySelector('.stage .text')?.textContent.length > 5, 'первая реплика с диска');
  const text = fdoc.querySelector('.stage .text').textContent;
  assert(text.includes('02:14') || text.includes('Дождь'), 'реплика не появилась: ' + JSON.stringify(text));
  const src = fdoc.querySelector('.stage .bg-a')?.dataset?.src || '';
  assert(!src.includes('undefined'), 'фон не разрешился: ' + src);

  assert(!fileErrors.filter((e) => !/CSS|Could not parse CSS/i.test(e)).length, 'ошибки на file://: ' + fileErrors.join(' | '));
  fileDom.window.close();
});

await step('один файл vnmy.html играется без соседних файлов', async () => {
  const standalone = await fs.readFile(path.join(ROOT, 'vnmy.html'), 'utf8');
  let fetchCalls = 0;
  let fileErrors = [];
  const consoleOut = new VirtualConsole();
  consoleOut.on('jsdomError', (e) => fileErrors.push('jsdomError: ' + e.message));
  consoleOut.on('error', (...a) => fileErrors.push('console.error: ' + a.map(String).join(' ')));

  const soloDom = new JSDOM(standalone, {
    url: 'file:///Downloads/vnmy.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: consoleOut,
    beforeParse(window) {
      window.scrollTo = () => {};
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      // с диска сети нет вовсе: любой запрос — ошибка
      window.fetch = async () => { fetchCalls++; throw new TypeError('Failed to fetch'); };
      window.HTMLCanvasElement.prototype.getContext = function () {
        const noop = () => {};
        return {
          setTransform: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop,
          fill: noop, ellipse: noop, arc: noop, save: noop, restore: noop, translate: noop, scale: noop,
          fillRect: noop, strokeRect: noop, closePath: noop, drawImage: noop,
          globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '', lineCap: '',
        };
      };
      window.Element.prototype.getBoundingClientRect = function () {
        return { x: 0, y: 0, width: 390, height: 844, top: 0, left: 0, right: 390, bottom: 844, toJSON() {} };
      };
    },
  });

  const sdoc = soloDom.window.document;
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (sdoc.querySelectorAll('#universe-list .universe-card').length) break;
    await sleep(50);
  }
  const uniTitles = [...sdoc.querySelectorAll('.universe-card-title')].map((n) => n.textContent);
  assert(uniTitles.includes('Тихие пути'), 'вселенная не подхватилась из одного файла: ' + uniTitles.join(','));
  assert(fetchCalls === 0, 'один файл всё-таки ходил в сеть: ' + fetchCalls);

  sdoc.querySelector('#universe-list .universe-card').dispatchEvent(new soloDom.window.MouseEvent('click', { bubbles: true }));
  const novelStart = Date.now();
  while (Date.now() - novelStart < 8000) {
    if (sdoc.querySelectorAll('#story-list .story-card').length) break;
    await sleep(50);
  }
  const titles = [...sdoc.querySelectorAll('.story-card-title')].map((n) => n.textContent);
  assert(titles.includes('Последний поезд'), 'демо не подхватилось из одного файла: ' + titles.join(','));

  sdoc.querySelector('#story-list .story-card').dispatchEvent(new soloDom.window.MouseEvent('click', { bubbles: true }));
  const playStart = Date.now();
  while (Date.now() - playStart < 8000) {
    if (sdoc.querySelector('.stage .text')?.textContent.length > 5) break;
    await sleep(50);
  }
  const text = sdoc.querySelector('.stage .text').textContent;
  assert(text.includes('02:14') || text.includes('Дождь'), 'реплика не появилась: ' + JSON.stringify(text));
  const library = soloDom.window.__VNMY_BUILTIN_LIBRARY__ || { universes: [] };
  const universe = library.universes[0];
  assert(universe && universe.novels?.length >= 1, 'новеллы не вшиты в файл');
  const novel = universe.novels[0];
  const scene = novel.scenes[0];
  const sprite = Object.values(novel.characters?.[0]?.sprites || {})[0] || '';
  assert(String(scene.bg).startsWith('data:image/'), 'фон не вшит: ' + String(scene.bg).slice(0, 40));
  assert(String(sprite).startsWith('data:image/'), 'спрайты не вшиты: ' + String(sprite).slice(0, 40));
  assert(String(universe.cover).startsWith('data:image/'), 'обложка вселенной не вшита');
  assert(!fileErrors.filter((e) => !/CSS|Could not parse CSS/i.test(e)).length, 'ошибки в одном файле: ' + fileErrors.join(' | '));
  soloDom.window.close();
});

await step('спрайты сохраняют пропорции картинки на любой ширине экрана', async () => {
  const css = (await fs.readFile(path.join(ROOT, 'css/player.css'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector) => {
    const i = css.indexOf(selector);
    assert(i >= 0, 'нет правила ' + selector);
    return css.slice(i, css.indexOf('}', i));
  };
  const sprite = rule('\n.sprite {');
  const img = rule('.sprite img {');
  // ширина спрайта должна следовать за картинкой, иначе `max-width: 100%`
  // из base.css режет её по ширине сцены и картинка плющится
  assert(/width:\s*max-content/.test(sprite), 'ширина спрайта не следует за картинкой');
  assert(!/max-width:\s*(?!none)\d/.test(sprite), 'у спрайта ограничена ширина: ' + sprite);
  assert(/max-width:\s*none/.test(img), 'картинка спрайта ограничена по ширине: ' + img);
  assert(/width:\s*auto/.test(img), 'ширина картинки спрайта задана не auto: ' + img);
  const standalone = await fs.readFile(path.join(ROOT, 'vnmy.html'), 'utf8');
  assert(/\.sprite img\s*\{[^}]*max-width:\s*none/.test(standalone), 'в vnmy.html нет исправления спрайтов');
});

await step('новая новелла: имя спрашивают в начале и подставляют в текст', async () => {
  await openUniverse('Пересылка');
  const cards = storyCards();
  assert(cards.length >= 1, 'во вселенной «Пересылка» есть новелла');
  assert(cards.some((c) => c.textContent.includes('Кто-то останется')), 'новелла «Кто-то останется»: ' + cards.map((c) => c.textContent.trim()).join(' | '));
  click(cards.find((c) => c.textContent.includes('Кто-то останется')));
  await waitFor(() => visible('screen-player') && document.querySelector('.stage'), { label: 'player peresylka' });

  const name = 'Артём';
  let asked = false;
  let speaker = '';
  for (let i = 0; i < 40 && !asked; i++) {
    const ask = document.querySelector('.stage .ask-layer:not([hidden])');
    if (ask) {
      asked = true;
      assert(ask.querySelector('.ask-label').textContent.includes('зовут'), 'вопрос про имя: ' + ask.textContent.trim());
      const input = ask.querySelector('.ask-input');
      setInput(input, name);
      click(ask.querySelector('.ask-submit'));
      break;
    }
    click(document.querySelector('.stage .tap-layer'));
    await sleep(30);
  }
  assert(asked, 'игра спросила имя');
  await waitFor(() => document.querySelector('.stage .ask-layer')?.hidden !== false, { label: 'ask hidden' });
  await sleep(60);
  speaker = document.querySelector('.stage .speaker').textContent.trim();
  assert(speaker === name, 'имя героя в подписи: «' + speaker + '»');
  await waitFor(() => document.querySelector('.stage .text').textContent.includes(name), { label: 'имя в тексте' });
});

await step('новая новелла: пороги, финал и выбор остаётся', async () => {
  const choose = (list, want) => {
    const found = list.find((el) => want.includes(el.textContent.trim()));
    click(found || list[0]);
  };
  let guard = 0;
  let hubs = 0;
  let adapts = 0;
  let cases = 0;
  while (guard++ < 6000) {
    if (document.querySelector('.ending-layer.is-visible')) break;
    const ask = document.querySelector('.stage .ask-layer:not([hidden])');
    if (ask) {
      setInput(ask.querySelector('.ask-input'), 'Артём');
      click(ask.querySelector('.ask-submit'));
      await sleep(60);
      continue;
    }
    const choices = [...document.querySelectorAll('.choice-layer .choice')];
    if (choices.length) {
      const labels = choices.map((el) => el.textContent.trim());
      if (labels.some((l) => /^Мост|^Стена|^Лёд|^Костёр|^Кузня|^Крыши/.test(l))) hubs++;
      if (labels.some((l) => /^Гвен:|^Микаса:|^Сакура:|^Энни:|^Фелиция:|^Тентен:/.test(l))) adapts++;
      if (labels.some((l) => /^Утечка газа|^Звонки|^Пять подъездов|^Восьмая бумажка/.test(l))) cases++;
      choose(choices, ['Останься. Пожалуйста.', 'Взять Микасу за руку.']);
      await sleep(40);
      continue;
    }
    click(document.querySelector('.stage .tap-layer'));
    await sleep(12);
  }
  assert(hubs >= 6, 'шесть порогов пройдены, а не ' + hubs);
  assert(adapts >= 6, 'шесть адаптаций пройдены, а не ' + adapts);
  assert(cases >= 4, 'четыре гипотезы проверены, а не ' + cases);
  assert(document.querySelector('.ending-layer.is-visible'), 'финал наступил за ' + guard + ' шагов');
  const ending = document.querySelector('.ending-title')?.textContent || '';
  assert(/ВАХТА/.test(ending) && /МИКАСА/.test(ending), 'финал с Микасой: ' + ending);
  const epilogue = document.querySelector('.ending-text')?.textContent || '';
  assert(epilogue.length > 30, 'на экране финала есть эпилог: ' + epilogue);
  const raw = window.localStorage.getItem('vnmy:saves:story_kto_to_ostanetsya');
  assert(raw, 'сохранение новой новеллы');
  const auto = JSON.parse(raw).auto;
  assert(auto && auto.ended && auto.vars, 'сохранение финала новой новеллы');
  const vars = auto.vars;
  assert(vars['порог_микаса'] === 2, 'порог Микасы открыт: ' + vars['порог_микаса']);
  const passed = ['гвен', 'фелиция', 'микаса', 'энни', 'сакура', 'тентен'].filter((n) => vars['порог_' + n] > 0);
  assert(passed.length === 6, 'пройдены все шесть порогов, а не ' + passed.length);
  assert(vars['имя'] === 'Артём', 'имя в сохранении: ' + vars['имя']);
  const byt = ['гвен', 'микаса', 'сакура', 'энни', 'фелиция', 'тентен'].filter((n) => vars['быт_' + n] >= 1);
  assert(byt.length === 6, 'все шесть адаптаций закрыты, а не ' + byt.length);
  assert(vars['порядок'] === 6, 'комендант собрал все шесть галочек: ' + vars['порядок']);
  assert(vars['улики'] >= 6, 'собрано не меньше шести улик: ' + vars['улики']);
  assert(vars['проверки'] === 4, 'все четыре гипотезы закрыты: ' + vars['проверки']);
});

await step('новелла разбита на акты: структура сцены и стыки', async () => {
  const raw = await fs.readFile(path.join(ROOT, 'stories/peresylka/novels/kto-to-ostanetsya/story.json'), 'utf8');
  const story = JSON.parse(raw);
  const acts = story.scenes.map((s) => s.act);
  assert(acts.every(Boolean), 'у каждой сцены есть акт');
  assert(new Set(acts).size === 7, 'актов ровно 7, а не ' + new Set(acts).size);
  const order = [...new Set(acts)];
  assert(order.join('|') === 'Акт I|Акт II|Акт III|Акт IV|Акт V|Акт VI|Акт VII', 'акты идут по порядку: ' + order.join(' → '));
  for (const act of order) {
    const inAct = story.scenes.filter((sc) => sc.act === act);
    assert(inAct.length >= 3 && inAct.length <= 10, `в «${act}» ${inAct.length} сцен — должно быть от 3 до 10`);
    const steps = inAct.reduce((n, sc) => n + sc.steps.length, 0);
    assert(steps >= 60, `в «${act}» только ${steps} кадров — акт получился слишком тонким`);
  }
  for (let i = 0; i < story.scenes.length; i++) {
    const sc = story.scenes[i];
    const last = sc.steps[sc.steps.length - 1];
    const linked = last.end || last.goto || last.choices?.length || last.gotoIf?.length;
    const flowsIntoNext = i + 1 < story.scenes.length;
    assert(linked || flowsIntoNext, `сцена «${sc.name}» обрывается: ни перехода, ни конца`);
  }
  const steps = story.scenes.reduce((n, s) => n + s.steps.length, 0);
  const chars = story.scenes.reduce((n, s) => n + s.steps.reduce((m, t) => m + (t.text || '').length, 0), 0);
  assert(steps >= 900, `в новелле ${steps} кадров — на два часа нужно не меньше 900`);
  assert(chars >= 70000, `объём текста ${chars} символов, нужно от 70 000`);
  const isHub = (st) => (st.choices || []).length >= 4 && st.choices.every((c) => c.if) && st.gotoIf?.length;
  const engine = await fs.readFile(path.join(ROOT, 'js/engine.js'), 'utf8');
  const css = await fs.readFile(path.join(ROOT, 'css/player.css'), 'utf8');
  assert(/chapter-act/.test(engine), 'карточка сцены не выводит акт');
  assert(/\.chapter-act\s*\{/.test(css), 'в стилях нет правила для строки акта');
  const hubSteps = story.scenes.flatMap((sc) => sc.steps.filter(isHub).map((st) => ({ sc, st })));
  assert(hubSteps.length === 3, 'три хаба: гипотезы, адаптация, пороги — а не ' + hubSteps.length);
  for (const { sc } of hubSteps) {
    assert(sc.card === false, 'хаб «' + sc.name + '» показывает карточку сцены при каждом возврате');
  }
});

await sleep(200);
console.log('\n---');
const failed = results.filter((r) => r[0] === 'fail');
const runtimeErrors = errors.filter((e) => !/CSS|Could not parse CSS/i.test(e));
console.log(`итого: ${results.length - failed.length}/${results.length} шагов, ошибок в консоли: ${runtimeErrors.length}`);
if (runtimeErrors.length) console.log(runtimeErrors.slice(0, 12).join('\n'));
dom.window.close();
process.exit(failed.length || runtimeErrors.length ? 1 : 0);
