import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
import { JSDOM } from 'jsdom';
import { bareId, normalizeStory } from '../js/format.js';
import { getSaves, saveSettings } from '../js/store.js';

const fixture = {
  id: 'route-check-fixture',
  vars: [{ name: 'trust', type: 'number', initial: 0 }],
  scenes: [{
    id: 'gate',
    steps: [
      { id: 'choice', choices: [{ text: 'Help', goto: 'help' }, { text: 'Leave', goto: 'leave' }] },
      { id: 'help', text: 'Helped', set: [{ var: 'trust', op: 'add', value: 1 }],
        gotoIf: [{ when: 'trust == 1', goto: 'together' }], goto: 'alone' },
      { id: 'leave', text: 'Left', goto: 'alone' },
      { id: 'together', end: true, text: 'Together' },
      { id: 'alone', end: true, text: 'Alone' },
    ],
  }],
};
const fixtureRoutes = [
  { name: 'help and resume', actions: [
    { at: 'gate:choice', choose: 'Help' },
    { at: 'gate:help', resume: true },
  ], end: 'gate:together', vars: { trust: 1 } },
  { name: 'leave', actions: [{ at: 'gate:choice', choose: 'Leave' }],
    end: 'gate:alone', vars: { trust: 0 } },
];

const positionOf = stage => `${stage.sceneId}:${bareId(stage.step.id)}`;

async function playRoute(story, route, { openPlayer, closePlayer }) {
  assert.ok(typeof route.name === 'string' && route.name.trim(), 'У маршрута должно быть имя');
  assert.ok(typeof route.end === 'string' && route.end.includes(':'), 'Укажите end в формате сцена:шаг');
  const actions = route.actions ?? [];
  assert.ok(Array.isArray(actions), 'actions должен быть массивом');
  for (const action of actions) {
    assert.ok(action && typeof action.at === 'string', 'У действия должен быть адрес at');
    const keys = ['choose', 'answer', 'resume'].filter(key => Object.hasOwn(action, key));
    assert.equal(keys.length, 1, 'Укажите одно из полей choose, answer, resume');
    assert.ok(keys[0] === 'resume' ? action.resume === true : typeof action[keys[0]] === 'string',
      'choose и answer должны быть строками, resume должен быть true');
  }

  localStorage.clear();
  saveSettings({ reduceMotion: true });
  let stage = openPlayer(story, { fresh: true });
  let index = 0;
  try {
    for (let tick = 0; tick < 10000; tick++) {
      const at = positionOf(stage);
      const action = actions[index]?.at === at ? actions[index] : null;
      if (stage.ended) {
        assert.equal(index, actions.length, `Осталось действие на ${actions[index]?.at}`);
        assert.ok(stage.step.end, `История закончилась без явной концовки на ${at}`);
        assert.equal(at, route.end, 'Открылась другая концовка');
        for (const [name, value] of Object.entries(route.vars ?? {})) {
          assert.deepEqual(stage.vars[name], value, `Переменная ${name} в финале`);
        }
        const save = getSaves(story.id).auto;
        assert.equal(save?.ended, true, 'Концовка не записалась в автосохранение');
        assert.equal(save.stepId, at);
        return;
      }
      if (action?.resume) {
        const { vars, visual } = stage.position;
        const history = structuredClone(stage.history);
        closePlayer();
        const save = getSaves(story.id).auto;
        assert.equal(save?.stepId, at, 'Автосохранение записано для другого шага');
        assert.deepEqual(save.vars, vars);
        stage = openPlayer(story);
        assert.equal(positionOf(stage), at, 'После загрузки изменился шаг');
        assert.deepEqual(stage.vars, vars, 'После загрузки изменились переменные');
        assert.deepEqual(stage.visual, visual, 'После загрузки изменилось состояние сцены');
        assert.deepEqual(stage.history, history, 'После загрузки изменился журнал');
        index++;
      } else if (stage.asking) {
        assert.ok(action?.answer !== undefined, `На ${at} ожидается answer`);
        stage.askInput.value = action.answer;
        stage.node.querySelector('.ask-submit').click();
        index++;
      } else if (stage.awaitingChoices) {
        assert.ok(action?.choose !== undefined, `На ${at} ожидается choose`);
        const options = [...stage.choiceLayer.querySelectorAll('button')]
          .filter(button => button.textContent === action.choose);
        assert.equal(options.length, 1, `На ${at} нужен один доступный вариант «${action.choose}»`);
        options[0].click();
        index++;
      } else {
        stage.tapLayer.click();
      }
    }
    throw new Error(`Маршрут не завершился за 10000 действий. Текущий шаг: ${positionOf(stage)}`);
  } finally {
    closePlayer();
  }
}

export async function checkRoutes(scan) {
  const html = await fs.readFile(new URL('../index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://vnmy.test/', pretendToBeVisual: true });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, setTransform() {} });
  for (const key of ['window', 'document', 'localStorage', 'Image', 'Node', 'HTMLElement',
    'requestAnimationFrame', 'cancelAnimationFrame']) {
    const value = typeof window[key] === 'function' && key.endsWith('AnimationFrame')
      ? window[key].bind(window) : window[key];
    globalThis[key] = value;
  }

  const failures = [];
  let passed = 0;
  const run = async (raw, routes, label, player) => {
    assert.ok(Array.isArray(routes) && routes.length, `${label}: ожидается непустой массив маршрутов`);
    const story = normalizeStory(structuredClone(raw));
    // Skip presentation delays while keeping the real player and storage path.
    for (const scene of story.scenes) for (const step of scene.steps) step.pause = 0;
    for (const route of routes) {
      try { await playRoute(story, route, player); passed++; }
      catch (error) { failures.push(`${label} / ${route?.name ?? '?'}: ${error.message}`); }
    }
  };

  try {
    const player = await import('../js/player.js');
    await run(fixture, fixtureRoutes, 'Самопроверка движка', player);
    const smoke = passed;
    for (const { dir, path: universePath = `stories/${dir}`, novels } of scan) {
      for (const { dir: novel, path: novelPath = `${universePath}/novels/${novel}`, story } of novels) {
        const file = path.resolve(ROOT, novelPath, 'routes.json');
        const label = path.relative(process.cwd(), file) || file;
        let source;
        try { source = await fs.readFile(file, 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        try { await run(story, JSON.parse(source), label, player); }
        catch (error) { failures.push(`${label}: ${error.message}`); }
      }
    }
    if (failures.length) throw new Error(`Проверка маршрутов:\n${failures.join('\n')}`);
    return { smoke, routes: passed - smoke };
  } finally {
    dom.window.close();
  }
}
