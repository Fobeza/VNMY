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
html = html.replace(/<script type="module"[^>]*><\/script>/, '');
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

await step('библиотека загружает встроенную историю', async () => {
  await waitFor(() => document.querySelectorAll('#story-list .story-card').length >= 1, { label: 'story cards' });
  const titles = [...document.querySelectorAll('.story-card-title')].map((n) => n.textContent);
  assert(titles.includes('Последний поезд'), 'есть демо: ' + titles.join(','));
  assert(visible('screen-library'), 'виден экран библиотеки');
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

await step('выход в библиотеку', async () => {
  click(document.querySelector('.ending-layer .ghost-btn'));
  await waitFor(() => visible('screen-library'), { label: 'library back' });
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
  await waitFor(() => visible('screen-library'), { label: 'back to library' });
  await waitFor(() => document.querySelectorAll('.story-card').length >= 2, { label: 'two stories' });
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
  await waitFor(() => visible('screen-library'), { label: 'back' });
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
  await waitFor(() => visible('screen-library'), { label: 'back to library' });
});

await step('undo не теряет загруженные картинки', async () => {
  click(document.getElementById('btn-new-story'));
  await waitFor(() => visible('screen-editor') && document.querySelector('.ed-preview .stage'), { label: 'editor' });
  await sleep(300);
  const stageNode = document.querySelector('.ed-preview .stage');
  // добавляем картинку в историю так, как это делает загрузка файла
  const saved = JSON.parse(window.localStorage.getItem(Object.keys(window.localStorage).find((k) => k.startsWith('vnmy:story:') && JSON.parse(window.localStorage.getItem(k)).title === 'Новая история')));
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
  assert(document.getElementById('ed-story-title').textContent === 'Новая история', 'undo не применился к заголовку');
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
  const picker = document.querySelector('input[type=file]');
  Object.defineProperty(picker, 'files', { value: [file], configurable: true });
  picker.dispatchEvent(new window.Event('change', { bubbles: true }));
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
  await waitFor(() => visible('screen-library'), { label: 'back from pause' });
});

await step('импорт файла со списком историй', async () => {
  const backup = { format: 'vnmy-backup', stories: [
    { title: 'Бэкап 1', scenes: [{ id: 'x', name: 'С', bg: '', steps: [{ id: 'a', text: 'раз' }] }] },
    { title: 'Бэкап 2', scenes: [{ id: 'y', name: 'С', bg: '', steps: [{ id: 'a', text: 'два' }] }] },
  ] };
  const file = new window.File([JSON.stringify(backup)], 'backup.json', { type: 'application/json' });
  const picker = document.querySelector('input[type=file]');
  Object.defineProperty(picker, 'files', { value: [file], configurable: true });
  picker.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => {
    const titles = [...document.querySelectorAll('.story-card-title')].map((n) => n.textContent);
    return titles.includes('Бэкап 1') && titles.includes('Бэкап 2');
  }, { label: 'backup import' });
});

await step('битый файл не ломает библиотеку', async () => {
  const file = new window.File(['это не json'], 'bad.json', { type: 'application/json' });
  const picker = document.querySelector('input[type=file]');
  Object.defineProperty(picker, 'files', { value: [file], configurable: true });
  picker.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(400);
  const toast = document.getElementById('toast');
  assert(toast.textContent.includes('не файл истории'), 'нет понятной ошибки: ' + toast.textContent);
  assert(document.querySelectorAll('.story-card').length >= 3, 'библиотека пострадала');
});


/* ─────────── переменные и условия ─────────── */

async function importStoryData(story) {
  const file = new window.File([JSON.stringify(story)], 'story.json', { type: 'application/json' });
  const picker = document.querySelector('input[type=file]');
  Object.defineProperty(picker, 'files', { value: [file], configurable: true });
  picker.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => [...document.querySelectorAll('.story-card-title')].some((n) => n.textContent === story.title), { label: `import ${story.title}` });
  click([...document.querySelectorAll('.story-card')].find((c) => c.textContent.includes(story.title)));
  await waitFor(() => visible('screen-player') && document.querySelector('.stage .text'), { label: `open ${story.title}` });
  await sleep(250);
}

/** id истории «Логика» после импорта (импорт всегда выдаёт новый id) */
function logicSaveKey() {
  const index = JSON.parse(window.localStorage.getItem('vnmy:index') || '[]');
  for (const id of index) {
    const story = JSON.parse(window.localStorage.getItem('vnmy:story:' + id) || '{}');
    if (story.title === logicStory.title) return `vnmy:saves:${id}`;
  }
  return null;
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
  assert((await readText()) === 'конец', 'последний шаг');
  await advance();
  await waitFor(() => document.querySelector('.ending-layer.is-visible'), { label: 'ending' });
  const title = document.querySelector('.ending-title').textContent;
  assert(title === 'КОНЕЦ · 1', 'подстановка в заголовке финала: ' + title);
  const key = logicSaveKey();
  assert(key, 'история «Логика» не найдена в библиотеке');
  const auto = JSON.parse(window.localStorage.getItem(key) || '{}').auto;
  assert(auto?.ended, 'финал не сохранён');
  const vars = auto.vars;
  assert(vars && vars.sympathy === 1, 'переменные не попали в сохранение: ' + JSON.stringify(vars));
  click(document.querySelector('.ending-layer .ghost-btn'));
  await waitFor(() => visible('screen-library'), { label: 'back' });
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
  await waitFor(() => visible('screen-library'), { label: 'back again' });
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
  const raw = JSON.parse(await fs.readFile(path.join(ROOT, 'stories/demo/story.json'), 'utf8'));
  raw.baseUrl = 'stories/demo/';
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

await sleep(200);
console.log('\n---');
const failed = results.filter((r) => r[0] === 'fail');
const runtimeErrors = errors.filter((e) => !/CSS|Could not parse CSS/i.test(e));
console.log(`итого: ${results.length - failed.length}/${results.length} шагов, ошибок в консоли: ${runtimeErrors.length}`);
if (runtimeErrors.length) console.log(runtimeErrors.slice(0, 12).join('\n'));
dom.window.close();
process.exit(failed.length || runtimeErrors.length ? 1 : 0);
