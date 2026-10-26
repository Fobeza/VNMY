/* VNMY — формат истории: схема, значения по умолчанию, нормализация.
 *
 * История (story.json)
 * {
 *   id, title, author, description, cover, accent,
 *   universe,                       // id вселенной (js/universe.js) или ''
 *   baseUrl,                        // откуда грузить относительные пути к картинкам
 *   vars: [{ name: 'sympathy', type: 'number', initial: 0 }],
 *   characters: [{ id, name, color, sprites: { neutral: 'assets/anya-neutral.webp' } }],
 *   scenes: [{
 *     id, name, bg, weather, cast: [ { char, sprite, pos, scale, dim } ],
 *     steps: [ Step ]
 *   }]
 * }
 *
 * Step
 * {
 *   id, speaker,      // id персонажа или null (мысли / рассказчик)
 *   text,             // реплика
 *   bg,               // сменить фон (необязательно)
 *   weather,          // сменить погоду
 *   cast,             // полностью заменить состав на сцене
 *   mood,             // подсказка для эффектов (например, 'shake')
 *   pause,            // пауза в мс перед показом реплики
 *   ask,              // { var, label, placeholder, value } — спросить у игрока значение
 *   if,               // условие: шаг покажется только если истинно
 *   set,              // [{ var, op: set|add|sub|toggle, value }] — при входе в шаг
 *   gotoIf,           // [{ when: условие, goto }] — условные переходы
 *   choices: [{ text, goto, if }],
 *   goto,             // переход на шаг «сцена#шаг» или id шага
 *   end               // true — конец истории / развилки
 * }
 */

import { compile as compileExpression, interpolatedVars } from './expr.js';

export const SCHEMA_VERSION = 1;

export const POSITIONS = ['left', 'center', 'right'];
export const POSITION_LABELS = { left: 'слева', center: 'по центру', right: 'справа' };
export const WEATHERS = ['none', 'rain', 'snow', 'dust', 'petals'];
export const WEATHER_LABELS = { none: 'ясно', rain: 'дождь', snow: 'снег', dust: 'пыль', petals: 'лепестки' };
export const MOODS = ['', 'shake', 'flash', 'blush', 'dim', 'zoom'];
export const MOOD_LABELS = {
  '': 'обычное', shake: 'тряска', flash: 'вспышка', blush: 'смущение', dim: 'затемнение', zoom: 'наплыв',
};
export const ACCENTS = ['#e0b072', '#d98a8a', '#8fb8d8', '#9ecf9a', '#b79ae0', '#d8d2c4'];
export const VAR_TYPES = ['number', 'bool', 'text'];
export const VAR_TYPE_LABELS = { number: 'число', bool: 'флаг', text: 'текст' };
export const VAR_OPS = ['set', 'add', 'sub', 'toggle'];
export const VAR_OP_LABELS = { set: '=', add: '+', sub: '−', toggle: 'переключить' };

export function newVar(overrides = {}) {
  return { name: 'переменная', type: 'number', initial: 0, ...overrides };
}

export function defaultVarValue(v) {
  if (v.type === 'bool') return v.initial === true || v.initial === 'true' || v.initial === 1 || v.initial === '1';
  if (v.type === 'number') {
    const n = Number(v.initial);
    return Number.isFinite(n) ? n : 0;
  }
  return v.initial == null ? '' : String(v.initial);
}

/** Стартовые значения всех переменных истории. */
export function defaultVars(story) {
  const vars = {};
  for (const v of story.vars || []) vars[v.name] = defaultVarValue(v);
  return vars;
}

export function varByName(story, name) {
  return (story.vars || []).find((v) => v.name === name) || null;
}

export function uid(prefix = 's') {
  return `${prefix}${Math.random().toString(36).slice(2, 7)}`;
}

export function newStep(overrides = {}) {
  return { id: uid('t'), speaker: null, text: '', ...overrides };
}

export function newScene(overrides = {}) {
  return {
    id: uid('sc'),
    name: 'Новая сцена',
    bg: '',
    weather: 'none',
    cast: [],
    steps: [newStep({ text: 'Первая реплика…' })],
    ...overrides,
  };
}

export function newCharacter(overrides = {}) {
  return { id: uid('ch'), name: 'Новый персонаж', color: '', sprites: {}, ...overrides };
}

export function createStory(overrides = {}) {
  const scene = newScene({ name: 'Начало' });
  return normalizeStory({
    schema: SCHEMA_VERSION,
    id: uid('story'),
    title: 'Без названия',
    author: '',
    description: '',
    cover: '',
    accent: ACCENTS[0],
    universe: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    characters: [],
    scenes: [scene],
    ...overrides,
  });
}

/** Приводит историю к актуальной схеме. Не бросает исключений — чинит по ходу. */
export function normalizeStory(input) {
  const story = input && typeof input === 'object' ? input : {};
  story.schema = SCHEMA_VERSION;
  story.id = story.id || uid('story');
  story.title = String(story.title || 'Без названия');
  story.author = String(story.author || '');
  story.description = String(story.description || '');
  story.cover = typeof story.cover === 'string' ? story.cover : '';
  story.accent = story.accent || ACCENTS[0];
  story.universe = typeof story.universe === 'string' ? story.universe.trim() : '';
  story.lang = typeof story.lang === 'string' && story.lang ? story.lang : 'ru';
  story.baseUrl = story.baseUrl || '';
  story.createdAt = story.createdAt || Date.now();
  story.updatedAt = story.updatedAt || Date.now();
  if (!Array.isArray(story.vars)) story.vars = [];
  const varNames = new Set();
  story.vars = story.vars.filter(Boolean).map((v) => {
    let name = String(v.name || '').trim().replace(/[^\p{L}\p{N}_]/gu, '_') || 'переменная';
    while (varNames.has(name)) name += '_2';
    varNames.add(name);
    const type = VAR_TYPES.includes(v.type) ? v.type : 'number';
    return { name, type, initial: v.initial ?? (type === 'bool' ? false : type === 'number' ? 0 : '') };
  });
  if (!Array.isArray(story.media)) story.media = [];
  story.media = story.media.filter(Boolean).map((m) => ({
    id: m.id || uid('m'),
    name: String(m.name || 'картинка'),
    url: String(m.url || ''),
    kind: 'image',
  })).filter((m) => m.url);
  if (!Array.isArray(story.characters)) story.characters = [];
  if (!Array.isArray(story.scenes)) story.scenes = [];
  if (!story.scenes.length) story.scenes.push(newScene({ name: 'Начало' }));

  const charIds = new Set();
  story.characters = story.characters.filter(Boolean).map((c) => {
    const char = { id: c.id || uid('ch'), name: String(c.name || 'Персонаж'), color: c.color || '', sprites: c.sprites && typeof c.sprites === 'object' ? c.sprites : {} };
    if (charIds.has(char.id)) char.id = uid('ch');
    charIds.add(char.id);
    return char;
  });

  const sceneIds = new Set();
  story.scenes = story.scenes.filter(Boolean).map((s) => {
    const scene = {
      id: s.id || uid('sc'),
      name: String(s.name || 'Сцена'),
      bg: typeof s.bg === 'string' ? s.bg : '',
      weather: WEATHERS.includes(s.weather) ? s.weather : 'none',
      cast: Array.isArray(s.cast) ? s.cast.map(normalizeCast).filter(Boolean) : [],
      steps: Array.isArray(s.steps) && s.steps.length ? s.steps : [newStep()],
    };
    if (sceneIds.has(scene.id)) scene.id = uid('sc');
    sceneIds.add(scene.id);
    const ids = new Set();
    scene.steps = scene.steps.filter(Boolean).map((t) => {
      const step = normalizeStep(t);
      if (ids.has(step.id)) step.id = uid('t');
      ids.add(step.id);
      return step;
    });
    return scene;
  });

  return story;
}

function normalizeCast(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    char: entry.char || null,
    sprite: entry.sprite || 'neutral',
    pos: POSITIONS.includes(entry.pos) ? entry.pos : 'center',
    scale: Number.isFinite(+entry.scale) ? +entry.scale : 1,
    dim: !!entry.dim,
    hidden: !!entry.hidden,
  };
}

function normalizeStep(t) {
  const step = {
    id: t.id || uid('t'),
    speaker: t.speaker || null,
    text: String(t.text ?? ''),
    choices: Array.isArray(t.choices) ? t.choices.filter(Boolean).map((c) => ({
      text: String(c.text || '…'),
      goto: String(c.goto || ''),
      ...(c.if ? { if: String(c.if) } : {}),
    })) : [],
    goto: t.goto ? String(t.goto) : '',
    end: !!t.end,
    mood: MOODS.includes(t.mood) ? t.mood : '',
    pause: Number.isFinite(+t.pause) ? +t.pause : 0,
  };
  if (typeof t.bg === 'string' && t.bg) step.bg = t.bg;
  if (WEATHERS.includes(t.weather)) step.weather = t.weather;
  if (Array.isArray(t.cast)) step.cast = t.cast.map(normalizeCast).filter(Boolean);
  if (t.note) step.note = String(t.note);
  if (t.spriteOverride) step.spriteOverride = String(t.spriteOverride);
  if (t.if) step.if = String(t.if);
  if (Array.isArray(t.set) && t.set.length) {
    step.set = t.set.filter(Boolean).map((op) => ({
      var: String(op.var || ''),
      op: VAR_OPS.includes(op.op) ? op.op : 'set',
      value: op.value ?? '',
    }));
  }
  if (Array.isArray(t.gotoIf) && t.gotoIf.length) {
    step.gotoIf = t.gotoIf.filter(Boolean).map((rule) => ({
      when: String(rule.when || ''),
      goto: String(rule.goto || ''),
    }));
  }
  if (t.ask && typeof t.ask === 'object' && t.ask.var) {
    // знакомство: спросить значение у игрока и положить его в переменную
    step.ask = {
      var: String(t.ask.var),
      label: String(t.ask.label || 'Как тебя зовут?'),
      placeholder: String(t.ask.placeholder || ''),
      value: t.ask.value == null ? '' : String(t.ask.value),
    };
  }
  if (t.endTitle) step.endTitle = String(t.endTitle);
  return step;
}

/** Локальный id шага без префикса сцены */
export function bareId(stepId = '') {
  const parts = String(stepId).split(':');
  return parts[parts.length - 1];
}

/** Глобальный id шага вида "sceneId:stepId" */
export function globalId(sceneId, stepId) {
  return `${sceneId}:${bareId(stepId)}`;
}

export function findScene(story, sceneId) {
  return story.scenes.find((s) => s.id === sceneId) || null;
}

export function findStepIndex(scene, stepId) {
  const bare = bareId(stepId);
  return scene.steps.findIndex((t) => bareId(t.id) === bare);
}

/** Универсальный резолвер ссылки "goto":
 *  "scX:tY" — шаг по id, "scX:3" — третий шаг сцены, "tY" — шаг текущей сцены, "scX" — начало сцены.
 */
export function resolveTarget(story, ref, currentSceneId) {
  if (!ref) return null;
  const [maybeScene, maybeStep] = String(ref).split(':');
  const byIndex = (scene) => {
    const n = parseInt(maybeStep, 10);
    if (!Number.isFinite(n)) return -1;
    return clampIndex(n - 1, scene.steps.length);
  };
  if (maybeStep !== undefined) {
    const scene = findScene(story, maybeScene);
    if (!scene) return null;
    const idx = /^-?\d+$/.test(maybeStep) ? byIndex(scene) : findStepIndex(scene, maybeStep);
    return idx < 0 ? null : { sceneId: scene.id, stepIndex: idx };
  }
  // без двоеточия: сначала ищем шаг в текущей сцене, потом сцену
  const current = findScene(story, currentSceneId);
  if (current) {
    const idx = findStepIndex(current, maybeScene);
    if (idx >= 0) return { sceneId: current.id, stepIndex: idx };
  }
  const scene = findScene(story, maybeScene);
  if (scene) return { sceneId: scene.id, stepIndex: 0 };
  return null;
}

function clampIndex(i, len) {
  if (i < 0) return -1;
  return Math.min(i, Math.max(0, len - 1));
}

/** Полное состояние сцены на конкретном шаге: с учётом всех переопределений. */
export function stateAt(story, sceneId, stepIndex) {
  const scene = findScene(story, sceneId);
  if (!scene) return { bg: '', weather: 'none', cast: [] };
  const state = { bg: scene.bg, weather: scene.weather, cast: scene.cast.map((c) => ({ ...c })) };
  const last = Math.min(stepIndex, scene.steps.length - 1);
  for (let i = 0; i <= last; i++) {
    const step = scene.steps[i];
    if (!step) break;
    if (step.bg) state.bg = step.bg;
    if (step.weather) state.weather = step.weather;
    if (step.cast) state.cast = step.cast.map((c) => ({ ...c }));
  }
  return state;
}

export function resolveUrl(story, url) {
  if (!url) return '';
  if (/^(https?:|data:|blob:|\/)/.test(url)) return url;
  return (story.baseUrl || '') + url;
}

export function characterById(story, id) {
  return story.characters.find((c) => c.id === id) || null;
}

/** Путь к спрайту как он записан в истории (без baseUrl). */
export function spritePath(story, charId, spriteKey) {
  const char = characterById(story, charId);
  if (!char) return '';
  const sprites = char.sprites || {};
  const key = spriteKey && sprites[spriteKey] ? spriteKey : Object.keys(sprites)[0];
  return key ? sprites[key] : '';
}

/** Готовый URL спрайта для <img src> / CSS. */
export function spriteUrl(story, charId, spriteKey) {
  return resolveUrl(story, spritePath(story, charId, spriteKey));
}

export function countWords(story) {
  let words = 0;
  let steps = 0;
  for (const scene of story.scenes) {
    for (const step of scene.steps) {
      steps++;
      words += (step.text || '').trim().split(/\s+/).filter(Boolean).length;
    }
  }
  return { words, steps };
}

/** Проверка ссылок и условий: показывает проблемы в редакторе и при импорте. */
export function lintStory(story) {
  const issues = [];
  const varNames = new Set((story.vars || []).map((v) => v.name));

  const checkCondition = (src, where, sceneId, stepId) => {
    if (!src) return;
    const { ast, deps, error } = compileExpression(src);
    if (error) {
      issues.push({ level: 'error', sceneId, stepId, text: `${where}: ошибка в условии — ${error.message}` });
      return;
    }
    for (const dep of deps) {
      if (!varNames.has(dep)) issues.push({ level: 'error', sceneId, stepId, text: `${where}: переменная «${dep}» не объявлена` });
    }
  };

  const checkAsk = (step, where, sceneId) => {
    if (!step.ask) return;
    if (!varNames.has(step.ask.var)) {
      issues.push({ level: 'error', sceneId, stepId: step.id, text: `${where}: спрашиваем «${step.ask.var}», но такой переменной нет` });
      return;
    }
    const variable = (story.vars || []).find((v) => v.name === step.ask.var);
    if (variable && variable.type !== 'text') {
      issues.push({ level: 'warn', sceneId, stepId: step.id, text: `${where}: «${step.ask.var}» не текстовая переменная — имя сохранится как число` });
    }
  };

  const checkText = (text, where, sceneId, stepId) => {
    for (const name of interpolatedVars(text)) {
      if (!varNames.has(name)) issues.push({ level: 'warn', sceneId, stepId, text: `${where}: в тексте есть {${name}}, но такой переменной нет` });
    }
  };

  const ids = new Set();
  for (let i = 0; i < story.scenes.length; i++) {
    const scene = story.scenes[i];
    if (!scene.bg) issues.push({ level: 'warn', sceneId: scene.id, text: `Сцена «${scene.name}» без фона` });
    for (const c of scene.cast) {
      if (!characterById(story, c.char)) issues.push({ level: 'error', sceneId: scene.id, text: `В сцене «${scene.name}» есть неизвестный персонаж` });
    }
    for (let j = 0; j < scene.steps.length; j++) {
      const step = scene.steps[j];
      if (!step.text && !step.ask && !step.choices?.length && !step.end) issues.push({ level: 'warn', stepId: step.id, sceneId: scene.id, text: `Пустая реплика #${j + 1}` });
      checkCondition(step.if, `Шаг #${j + 1}: условие показа`, scene.id, step.id);
      checkText(step.text, `Шаг #${j + 1}`, scene.id, step.id);
      checkAsk(step, `Шаг #${j + 1}`, scene.id);
      for (const op of step.set || []) {
        if (!varNames.has(op.var)) {
          issues.push({ level: 'error', stepId: step.id, sceneId: scene.id, text: `Шаг #${j + 1}: изменение несуществующей переменной «${op.var || '—'}»` });
        }
        if (op.op === 'add' || op.op === 'sub') {
          const type = varByName(story, op.var)?.type;
          if (type === 'bool' && op.op !== 'toggle') {
            issues.push({ level: 'warn', stepId: step.id, sceneId: scene.id, text: `Шаг #${j + 1}: «${op.var}» — флаг, для него есть «переключить»` });
          }
        }
        if (op.op === 'toggle' && varByName(story, op.var)?.type !== 'bool') {
          issues.push({ level: 'warn', stepId: step.id, sceneId: scene.id, text: `Шаг #${j + 1}: «переключить» для не-флага «${op.var}»` });
        }
      }
      for (const [k, rule] of (step.gotoIf || []).entries()) {
        checkCondition(rule.when, `Шаг #${j + 1}: условный переход ${k + 1}`, scene.id, step.id);
        if (!rule.goto) issues.push({ level: 'error', stepId: step.id, sceneId: scene.id, text: `Шаг #${j + 1}: у условного перехода ${k + 1} нет цели` });
        else if (!resolveTarget(story, rule.goto, scene.id)) issues.push({ level: 'error', stepId: step.id, sceneId: scene.id, text: `Шаг #${j + 1}: условный переход ${k + 1} ведёт в никуда` });
      }
      for (const choice of step.choices || []) {
        checkCondition(choice.if, `Выбор «${choice.text}»`, scene.id, step.id);
        checkText(choice.text, `Выбор «${choice.text}»`, scene.id, step.id);
        if (!choice.goto) issues.push({ level: 'error', stepId: step.id, sceneId: scene.id, text: `У выбора «${choice.text}» нет перехода` });
        else if (!resolveTarget(story, choice.goto, scene.id)) issues.push({ level: 'error', stepId: step.id, sceneId: scene.id, text: `Выбор «${choice.text}» ведёт в никуда` });
      }
      if (step.goto && !resolveTarget(story, step.goto, scene.id)) issues.push({ level: 'error', stepId: step.id, sceneId: scene.id, text: `Переход после реплики #${j + 1} ведёт в никуда` });
      if (step.end && step.choices?.length) issues.push({ level: 'warn', stepId: step.id, sceneId: scene.id, text: `Шаг #${j + 1}: одновременно «конец» и выборы — сработают выборы` });
      if (step.goto) ids.add(step.goto);
      if (step.end) continue;
      const isLast = j === scene.steps.length - 1;
      if (isLast && !step.choices?.length && !step.goto) {
        const nextScene = story.scenes[i + 1];
        if (!nextScene) issues.push({ level: 'warn', stepId: step.id, sceneId: scene.id, text: `Финал сцены «${scene.name}» — история здесь закончится. Поставьте «Конец» или переход.` });
      }
    }
  }
  return issues;
}
