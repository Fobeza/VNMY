/* Регрессии из разбора движка 2.8: сохранения, журнал, условия, расстановка, импорт. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://vnmy.test/', pretendToBeVisual: true });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, setTransform() {} });
for (const key of ['window', 'document', 'localStorage', 'Image', 'Node', 'HTMLElement', 'CustomEvent', 'FileReader', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  globalThis[key] = key.endsWith('AnimationFrame') ? window[key].bind(window) : window[key];
}
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const top = () => [...document.querySelectorAll('.sheet')].filter(node => !node.inert).at(-1);

try {
  const { compile, evalCondition, applyOperation } = await import('../js/expr.js');
  const { normalizeStory, lintStory, stabilizeCast, resolveUrl, registerAssetUrls } = await import('../js/format.js');
  const store = await import('../js/store.js');
  const { openPlayer, closePlayer, openSaves } = await import('../js/player.js');
  const { openSheet, closeTopModal } = await import('../js/ui.js');

  // условия: отрицательные числа, минус после значения — по-прежнему ошибка
  assert.equal(compile('trust > -1').error, null);
  assert.equal(evalCondition('trust > -1', { trust: 0 }), true);
  assert.equal(evalCondition('x == -2.5', { x: -2.5 }), true);
  assert.ok(compile('a-1').error, 'арифметики в условиях нет');
  // операции не портят тип переменной
  assert.equal(applyOperation('abc', 'sub', 'x', 'text'), 'abc');
  assert.equal(applyOperation(false, 'add', 1, 'bool'), true);
  assert.equal(applyOperation(true, 'sub', 1, 'bool'), false);
  assert.equal(applyOperation(3, 'sub', '1,5', 'number'), 1.5);

  // переменные: исправленное имя не захватывает существующую переменную
  const vars = normalizeStory({ vars: [{ name: 'a b' }, { name: 'a_b' }, { name: 'a_b' }, { name: '2nd' }], scenes: [{ steps: [{ text: '.' }] }] }).vars.map(v => v.name);
  assert.deepEqual(vars, ['a_b_2', 'a_b', '_2nd']);

  // lint: пустое условие перехода, концовка с переходом, вычитание из текста
  const linted = lintStory(normalizeStory({ vars: [{ name: 'name', type: 'text' }], scenes: [{ id: 's', bg: 'b.webp', steps: [
    { id: 'a', text: '1', set: [{ var: 'name', op: 'sub', value: 'x' }], gotoIf: [{ when: '', goto: 's:b' }] },
    { id: 'b', text: '2', end: true, goto: 's:a' },
  ] }] })).map(issue => issue.text).join('\n');
  assert.match(linted, /пустое условие/);
  assert.match(linted, /у концовки есть переход/);
  assert.match(linted, /нельзя вычитать/);

  // stable: явное перемещение на занятое место меняет персонажей местами
  const swapped = Object.fromEntries(stabilizeCast([{ char: 'a', pos: 'left' }, { char: 'b', pos: 'right' }],
    [{ char: 'a', pos: 'left' }, { char: 'b', pos: 'left', move: true }]).map(c => [c.char, c.pos]));
  assert.deepEqual(swapped, { a: 'right', b: 'left' });

  // stable: состав выравнивается по числу персонажей, порядок сохраняется
  const placed = (prev, next) => Object.fromEntries(stabilizeCast(prev, next).map(c => [c.char, c.pos]));
  assert.deepEqual(placed([{ char: 'a', pos: 'center' }], [{ char: 'a', pos: 'center' }, { char: 'b', pos: 'right' }]), { a: 'left', b: 'right' });
  assert.deepEqual(placed([{ char: 'a', pos: 'center' }], [{ char: 'a', pos: 'center' }, { char: 'b', pos: 'left' }]), { a: 'right', b: 'left' });
  assert.deepEqual(placed([{ char: 'a', pos: 'left' }, { char: 'b', pos: 'right' }], [{ char: 'b', pos: 'right' }]), { b: 'center' });
  assert.deepEqual(placed([{ char: 'a', pos: 'left' }, { char: 'b', pos: 'center' }, { char: 'c', pos: 'right' }],
    [{ char: 'a', pos: 'left' }, { char: 'c', pos: 'right' }]), { a: 'left', c: 'right' });

  // сцену нельзя прокрутить вбок: иначе экран концовки съезжает
  const playerCss = readFileSync(new URL('../css/player.css', import.meta.url), 'utf8');
  assert.match(playerCss, /\.stage \{[^}]*overflow: clip;/s);

  // картинка пакета не запрашивается у сайта приложения
  assert.equal(resolveUrl({ id: 'pkg', packaged: true }, 'assets/missing.webp'), '');
  registerAssetUrls('pkg', new Map([['assets/bg.webp', 'blob:https://vnmy.test/bg']]));
  assert.equal(resolveUrl({ id: 'pkg', packaged: true }, 'assets/bg.webp'), 'blob:https://vnmy.test/bg');
  assert.equal(resolveUrl({ id: 'pkg', packaged: true }, 'https://example.test/a.webp'), 'https://example.test/a.webp');

  store.saveSettings({ reduceMotion: true, keepAwake: false });
  const story = normalizeStory({ id: 'fixes', title: 'Fixes', vars: [{ name: 'hero', type: 'text', initial: '' }], scenes: [
    { id: 's1', name: 'Первая', steps: [
      { id: 'ask', text: 'Привет, {hero}', ask: { var: 'hero', label: 'Имя?' } },
      { id: 'b', text: 'B' },
      { id: 'silent', bg: 'night.webp' },
      { id: 'c', text: 'C' },
      { id: 'end', text: 'fin', end: true },
    ] },
  ] });

  // карточка первой сцены при новой игре; ask попадает в журнал один раз
  let stage = openPlayer(story, { fresh: true });
  assert.ok(document.querySelector('.chapter-card'), 'карточка первой сцены');
  stage.askInput.value = 'Аня'; stage.submitAsk();
  assert.deepEqual(stage.history.map(h => h.text), ['Привет, Аня']);
  assert.match(stage.liveEl.textContent, /Привет, Аня/, 'диктор получает реплику целиком');

  // шаг без реплики не останавливает авточтение
  stage.handleTap(); // → b
  let advanced = 0;
  stage.autoReading = true;
  const realAdvance = stage.advance.bind(stage);
  stage.advance = () => { advanced++; realAdvance(); };
  stage.handleTap(); // → silent
  assert.equal(stage.step.id, 'silent');
  const queued = advanced;
  await tick(1700);
  assert.ok(advanced > queued, 'авточтение идёт дальше с шага без текста');
  stage.autoReading = false;
  stage.advance = realAdvance;

  // «Загрузить → Авто» после новой игры не начинает сначала
  while (stage.step.id !== 'c') stage.handleTap();
  await tick(400);
  assert.equal(store.getSaves(story.id).auto.stepId, 's1:c');
  openSaves(story, { fresh: true }, 'load'); await tick();
  [...top().querySelectorAll('.reader-tab')].find(b => b.textContent === 'Авто').click();
  top().querySelector('.save-select').click();
  top().querySelector('.save-action').click(); await tick();
  assert.equal(document.querySelector('#player-host .text').textContent, 'C', 'загружен автосейв');
  assert.equal(store.getSaves(story.id).auto.stepId, 's1:c', 'автосейв не затёрт');
  closePlayer();

  // явная загрузка автосейва на концовке показывает концовку, а не начало
  store.writeSave(story.id, 'auto', { ...store.getSaves(story.id).auto, stepIndex: 4, stepId: 's1:end', ended: true });
  stage = openPlayer(story, { slot: 'auto' });
  assert.equal(stage.step.id, 'end');
  closePlayer();

  // «Продолжить» открывает то же сохранение, по которому показан прогресс
  localStorage.clear(); store.saveSettings({ reduceMotion: true, keepAwake: false });
  store.writeSave(story.id, '1', { sceneId: 's1', stepIndex: 3, stepId: 's1:c', sceneName: 'Первая', percent: .6, vars: { hero: 'Аня' } });
  assert.equal(store.progressOf(story.id).stepId, 's1:c');
  stage = openPlayer(story, {});
  assert.equal(stage.step.id, 'c');
  closePlayer();

  // «пропускать прочитанное» учитывает и реплики, прочитанные в этой сессии
  store.saveSettings({ skipSeen: true });
  localStorage.removeItem(`vnmy:seen:${story.id}`);
  stage = openPlayer(story, { fresh: true });
  assert.equal(stage._stepWasSeen, false);
  stage.goTo('s1', 1); assert.equal(stage._stepWasSeen, false);
  stage.goTo('s1', 1); assert.equal(stage._stepWasSeen, true);
  closePlayer();
  store.saveSettings({ skipSeen: false });

  // журнал окрашивает имя цветом персонажа, как на сцене
  const colored = normalizeStory({ id: 'colors', characters: [{ id: 'anya', name: 'Аня', color: '#e7a0b8' }],
    scenes: [{ id: 's', card: false, steps: [{ id: 'a', speaker: 'anya', text: 'Привет' }, { id: 'b', text: 'Дальше' }] }] });
  stage = openPlayer(colored, { fresh: true });
  stage.opts.onJournal(); await tick();
  assert.equal(top().querySelector('.journal-name').style.color, 'rgb(231, 160, 184)');
  closeTopModal(); await tick();
  closePlayer();

  // «Назад» телефона закрывает верхнее окно
  openSheet({ title: 'Окно' }); await tick();
  assert.equal(closeTopModal(), true);
  assert.equal(closeTopModal(), false);

  // импорт JSON сохраняет id: повторный импорт обновляет новеллу
  const file = (data) => new window.Blob([JSON.stringify(data)], { type: 'application/json' });
  const raw = { id: 'json-story', title: 'Первая', scenes: [{ id: 's', steps: [{ id: 't', text: '1' }] }] };
  await store.importStoryFile(file(raw));
  await store.importStoryFile(file({ ...raw, title: 'Вторая' }));
  assert.equal(store.listLocalStoryIds().filter(id => id === 'json-story').length, 1);
  assert.equal(store.loadLocalStory('json-story').title, 'Вторая');

  // битая вторая новелла пакета не оставляет половину импорта
  const before = store.listLocalStoryIds().length;
  const files = new Map([
    ['universe.json', file({ id: 'atomic', title: 'Atomic' })],
    ['novels/a/story.json', file({ id: 'atomic-a', scenes: [{ id: 's', steps: [{ id: 't', text: '1' }] }] })],
    ['novels/b/story.json', new window.Blob(['{broken'])],
  ]);
  await assert.rejects(store.importPackage(files), /BAD_JSON/);
  assert.equal(store.listLocalStoryIds().length, before);
  assert.equal(store.loadLocalUniverse('atomic'), null);

  // валидатор: некорректные и повторные имена переменных — ошибка
  const { validateStories } = await import('./validate.mjs');
  const badVars = { id: 'bad-vars', vars: [{ name: 'a b' }, { name: 'x' }, { name: 'x' }], scenes: [{ id: 's', steps: [{ id: 't', text: '1', end: true }] }] };
  await assert.rejects(validateStories([{ dir: 'bad', single: true, novels: [{ dir: 'bad', path: 'tools', story: badVars }] }]),
    (err) => /некорректное имя переменной «a b»/.test(err.message) && /«x» объявлена дважды/.test(err.message));

  console.log('Исправления 2.8–2.9: сохранения и «Продолжить», журнал ask и цвета имён, карточка сцены, авточтение, условия, расстановка, «Назад», импорт, сцена без прокрутки — пройдено');
} finally {
  dom.window.close();
}
