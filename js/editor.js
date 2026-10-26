/* VNMY — встроенный редактор историй.
 * Всё сохраняется в localStorage этого браузера; экспорт — в story.json.
 */
import { Stage } from './engine.js';
import { POSITION_SHORT } from './editor-tabs.js';
import {
  findScene, newStep, newScene, newCharacter, stateAt, POSITIONS, POSITION_LABELS, WEATHERS,
  WEATHER_LABELS, MOODS, MOOD_LABELS, ACCENTS, lintStory, normalizeStory, bareId, resolveTarget,
  VAR_TYPES, VAR_TYPE_LABELS, VAR_OPS, VAR_OP_LABELS, newVar,
  characterById, spritePath, createStory, resolveUrl,
} from './format.js';
import {
  saveStory, exportStory, exportStoryPortable, duplicateStory, deleteStory, clearSaves,
  getSettings, storageUsage,
} from './store.js';
import { el, $, $$, deepClone, debounce, plural } from './util.js';
import { formatValue } from './expr.js';
import { toast, openSheet, confirmDialog } from './ui.js';
import { ICONS as MENU_ICONS } from './icons.js';
import { renderSceneTab, renderStoryTab, renderMediaTab } from './editor-tabs.js';
import {
  field, textInput, textArea, selectControl, chips, rangeControl, switchControl, segmented,
  section, iconButton, ICONS, imageControl, pickMedia, conditionInput,
} from './editor-ui.js';

const TABS = [
  { id: 'step', label: 'Шаг' },
  { id: 'scene', label: 'Сцена' },
  { id: 'story', label: 'История' },
  { id: 'media', label: 'Медиа' },
];

let S = null;
let wired = false;
let headerWired = false;

/* ─────────────────────────── открытие / закрытие ─────────────────────────── */

export function openEditor(story, opts = {}) {
  closeEditor({ silent: true });
  const working = story.readOnly ? duplicateStory(story) : story;
  S = {
    story: normalizeStory(deepClone(working)),
    original: working,
    opts,
    sceneId: working.scenes[0].id,
    stepIndex: 0,
    tab: 'step',
    stage: null,
    dirty: false,
    undo: [],
    redo: [],
    undoBytes: 0,
    redoBytes: 0,
    previewAnimated: false,
    lastKey: '',
    textFocus: false,
  };
  S.sceneId = S.story.scenes[0].id;

  document.documentElement.lang = S.story.lang || 'ru';
  $('#ed-story-title').textContent = S.story.title || 'История';
  setSaveState('сохранено');
  wireOnce();
  ensureHeaderActions();
  renderTabs();
  renderPanel();
  mountPreview();

  if (opts.isNew) {
    setTimeout(() => {
      const input = $('.ed-tab-body .js-title-input');
      input?.focus();
      input?.select?.();
    }, 120);
  }
  return S;
}

export function closeEditor({ silent = false } = {}) {
  if (!S) return;
  flushSave();
  S.stage?.destroy();
  S.stage = null;
  $('#ed-preview') && ($('#ed-preview').innerHTML = '');
  S = null;
  if (!silent) toast('Редактор закрыт');
}

export function isEditorDirty() {
  return !!(S && S.dirty);
}

/* ─────────────────────────── сохранение ─────────────────────────── */

const scheduleSave = debounce(() => flushSave(), 500);

function flushSave() {
  if (!S) return;
  try {
    saveStory(S.story);
    S.dirty = false;
    S.original = S.story;
    setSaveState(`сохранено · ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`);
  } catch (err) {
    console.error(err);
    if (String(err?.message) === 'STORAGE_FULL') {
      setSaveState('не сохранено — мало места');
      toast('В браузере мало места. Уменьшите картинки или экспортируйте историю в файл.');
    } else {
      setSaveState('ошибка сохранения');
    }
  }
}

function markDirty() {
  if (!S) return;
  S.dirty = true;
  setSaveState('сохраняем…');
  scheduleSave();
}

function setSaveState(text) {
  const node = $('#ed-save-state');
  if (node) node.textContent = text;
}

/* ─────────────────────────── undo ─────────────────────────── */

const UNDO_LIMIT = 50;
const UNDO_BUDGET = 2 * 1024 * 1024; // символы, а не мегабайты: снимки живут в памяти

/**
 * Снимок истории для undo. Картинки, загруженные в редакторе (data URL),
 * не копируются: они неизменяемы, поэтому берём их из текущей истории.
 * Так снимок весит килобайты, а не мегабайты.
 */
function snapshot() {
  const data = { ...S.story, media: undefined };
  return JSON.stringify(data);
}

function restoreMedia(snapshotJson) {
  const parsed = JSON.parse(snapshotJson);
  parsed.media = S.story.media || [];
  return normalizeStory(parsed);
}

function pushUndo() {
  if (!S) return;
  const snap = snapshot();
  S.undo.push(snap);
  S.undoBytes = (S.undoBytes || 0) + snap.length;
  while (S.undo.length > UNDO_LIMIT || (S.undoBytes > UNDO_BUDGET && S.undo.length > 1)) {
    const dropped = S.undo.shift();
    S.undoBytes -= dropped.length;
  }
  S.redo.length = 0;
  S.redoBytes = 0;
  updateUndoButtons();
}

function undo() {
  if (!S.undo.length) return;
  const current = snapshot();
  S.redo.push(current);
  S.redoBytes = (S.redoBytes || 0) + current.length;
  const snap = S.undo.pop();
  S.undoBytes = Math.max(0, (S.undoBytes || 0) - snap.length);
  applySnapshot(restoreMedia(snap));
  toast('Отменено');
}

function redo() {
  if (!S.redo.length) return;
  const current = snapshot();
  S.undo.push(current);
  S.undoBytes = (S.undoBytes || 0) + current.length;
  const snap = S.redo.pop();
  S.redoBytes = Math.max(0, (S.redoBytes || 0) - snap.length);
  applySnapshot(restoreMedia(snap));
}

function applySnapshot(next) {
  S.story = next;
  if (!findScene(S.story, S.sceneId)) S.sceneId = S.story.scenes[0].id;
  S.stepIndex = Math.min(S.stepIndex, Math.max(0, findScene(S.story, S.sceneId).steps.length - 1));
  markDirty();
  $('#ed-story-title').textContent = S.story.title || 'История';
  // превью не пересоздаём: подменяем историю и обновляем текущий шаг
  if (S.stage) {
    S.stage.story = S.story;
    S.stage.node.style.setProperty('--accent', S.story.accent || '#e0b072');
    // переход по клику в редакторе не должен повторно применять изменения переменных
  S.stage.goTo(S.sceneId, S.stepIndex, { instant: !S.previewAnimated, effects: false, force: true });
  } else {
    mountPreview();
  }
  renderPanel();
  updateUndoButtons();
}

function updateUndoButtons() {
  const u = $('#ed-undo');
  const r = $('#ed-redo');
  if (u) u.disabled = !S?.undo.length;
  if (r) r.disabled = !S?.redo.length;
}

/* ─────────────────────────── каркас ─────────────────────────── */

function wireOnce() {
  if (wired) return;
  wired = true;

  $('#ed-close').addEventListener('click', () => S?.opts.onExit?.());
  $('#ed-menu').addEventListener('click', openEditorMenu);
  $('#ed-preview-restart').addEventListener('click', () => {
    S.previewAnimated = !S.previewAnimated;
    $('#ed-preview-restart').textContent = S.previewAnimated ? 'без анимации' : 'с печатью';
    S.lastKey = '';
    renderPanel();
    refreshPreview({ instant: !S.previewAnimated });
  });
  $('#ed-preview-collapse').addEventListener('click', () => {
    const wrap = document.querySelector('.ed-preview-wrap');
    wrap?.classList.toggle('is-collapsed');
    const collapsed = wrap?.classList.contains('is-collapsed');
    S.stage?.applySettings({});
    if (!collapsed) requestAnimationFrame(() => { S.stage?.weather?.resize(); });
    $('#ed-hint').textContent = collapsed
      ? 'превью свернуто — больше места для панели'
      : 'нажмите на сцену, чтобы перейти к шагу';
  });
  $('#ed-play-toggle').addEventListener('click', () => {
    flushSave();
    S.opts.onPlay?.(S.story);
  });
  $('#ed-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    S.tab = btn.dataset.tab;
    renderTabs();
    renderPanel();
  });
  document.addEventListener('keydown', onKeyDown);

  // не терять последние правки, если вкладку свернули или закрыли
  window.addEventListener('pagehide', flushSafe);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushSafe();
  });
}

function flushSafe() {
  if (!S) return;
  try {
    if (S.dirty) flushSave();
  } catch { /* в pagehide уже ничего не показать */ }
}

function onKeyDown(e) {
  if (!S) return;
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    if (typing) return;
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  }
  if (e.key === 'Escape' && document.body.classList.contains('no-scroll')) return;
}

function renderTabs() {
  $$('#ed-tabs button').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === S.tab));
  const playToggle = $('#ed-play-toggle');
  if (playToggle) playToggle.textContent = 'Играть';
  const restart = $('#ed-preview-restart');
  if (restart) restart.textContent = S.previewAnimated ? 'без анимации' : 'с печатью';
  updateUndoButtons();
}

function ensureHeaderActions() {
  if ($('#ed-undo')) return;
  const undoBtn = iconButton(ICONS.undo, { label: 'Отменить', onclick: undo });
  undoBtn.id = 'ed-undo';
  const redoBtn = iconButton(ICONS.redo, { label: 'Повторить', onclick: redo });
  redoBtn.id = 'ed-redo';
  const actions = el('div', { class: 'ed-undo-group' }, undoBtn, redoBtn);
  $('.ed-head').insertBefore(actions, $('#ed-menu'));
  if (!headerWired) {
    headerWired = true;
    undoBtn.addEventListener('click', undo);
    redoBtn.addEventListener('click', redo);
  }
  updateUndoButtons();
}

/* ─────────────────────────── панель ─────────────────────────── */

function renderPanel() {
  if (!S) return;
  const body = $('#ed-tab-body');
  const scroll = body.scrollTop;
  body.innerHTML = '';
  const ctx = makeCtx();
  let content = null;
  if (S.tab === 'step') content = renderStepTab(ctx);
  else if (S.tab === 'scene') content = renderSceneTab(ctx);
  else if (S.tab === 'story') content = renderStoryTab(ctx);
  else if (S.tab === 'media') content = renderMediaTab(ctx);
  if (content) body.append(content);
  body.scrollTop = scroll;
  S.lastKey = `${S.sceneId}:${S.stepIndex}`;
}

function makeCtx() {
  const ctx = {
    get story() { return S.story; },
    get scene() { return findScene(S.story, S.sceneId); },
    get sceneId() { return S.sceneId; },
    get step() { return findScene(S.story, S.sceneId)?.steps[S.stepIndex] || null; },
    get stepIndex() { return S.stepIndex; },
    get tab() { return S.tab; },
    get ui() { return { field, textInput, textArea, selectControl, chips, rangeControl, switchControl, segmented, section, iconButton, ICONS, imageControl, pickMedia, conditionInput, toast, openSheet, confirmDialog }; },
    pushUndo,
    markDirty,
    saveNow: flushSave,
    /** перерисовать панель и превью */
    commit({ panel = true, preview = true, instant = !S.previewAnimated } = {}) {
      markDirty();
      if (panel) renderPanel();
      if (preview) refreshPreview({ instant });
    },
    /** правка без перерисовки панели (для полей ввода) */
    patch(fn, { panel = false, preview = true } = {}) {
      if (typeof fn === 'function') fn(S.story);
      markDirty();
      if (panel) renderPanel();
      if (preview) schedulePreviewRefresh();
    },
    selectScene(sceneId, { panel = true } = {}) {
      if (!findScene(S.story, sceneId)) return;
      S.sceneId = sceneId;
      S.stepIndex = 0;
      markDirty();
      if (panel) renderPanel();
      goToCurrent();
    },
    selectStep(sceneId, stepIndex, { panel = true } = {}) {
      const scene = findScene(S.story, sceneId);
      if (!scene) return;
      S.sceneId = sceneId;
      S.stepIndex = Math.max(0, Math.min(stepIndex, scene.steps.length - 1));
      if (panel) renderPanel();
      goToCurrent();
    },
    switchTab(tab) {
      S.tab = tab;
      renderTabs();
      renderPanel();
    },
    remountPreview: mountPreview,
    refreshPreview,
    addCharacter(name) {
      const char = newCharacter({ name: name || `Персонаж ${S.story.characters.length + 1}` });
      pushUndo();
      S.story.characters.push(char);
      markDirty();
      return char;
    },
    goToCurrent,
    updateTitle(title) {
      $('#ed-story-title').textContent = title || 'История';
    },
    exportStory: () => exportStory(S.story),
    duplicate: () => {
      flushSave();
      const copy = duplicateStory(S.story);
      openEditor(copy, { onExit: S.opts.onExit, onPlay: S.opts.onPlay });
      return copy;
    },
    removeStory: async () => {
      const ok = await confirmDialog({ title: 'Удалить историю?', text: `«${S.story.title}» будет удалена из этого браузера. Экспортированный файл останется.`, confirmText: 'Удалить' });
      if (!ok) return;
      deleteStory(S.story.id);
      const exit = S.opts.onExit;
      closeEditor({ silent: true });
      toast('История удалена');
      exit?.();
    },
  };
  return ctx;
}

async function portableExport(story) {
  flushSave();
  toast('Собираю картинки…', 8000);
  try {
    const result = await exportStoryPortable(story);
    toast(result.skipped
      ? `Готово: ${(result.bytes / 1024 / 1024).toFixed(1)} МБ, ${result.images} картинок, ${result.skipped} пропущено`
      : `Готово: ${(result.bytes / 1024 / 1024).toFixed(1)} МБ, картинок: ${result.images}`);
  } catch (err) {
    console.error(err);
    toast('Не получилось собрать файл');
  }
}

function openEditorMenu() {
  if (!S) return;
  openSheet({
    title: S.story.title,
    subtitle: 'Редактор · изменения сохраняются в браузере',
    rows: [
      { label: 'Играть с начала', icon: MENU_ICONS.play, onSelect: () => { flushSave(); S.opts.onPlay?.(S.story); } },
      { label: 'Экспорт с картинками', icon: MENU_ICONS.download, hint: 'один файл, переносится на любое устройство', onSelect: () => portableExport(S.story) },
      { label: 'Экспорт JSON', icon: MENU_ICONS.download, hint: 'только сценарий, картинки — путями', onSelect: () => exportStory(S.story) },
      { label: 'Дублировать историю', icon: MENU_ICONS.copy, onSelect: () => { const ctx = makeCtx(); ctx.duplicate(); } },
      { label: 'Забыть прогресс чтения', icon: MENU_ICONS.restart, hint: 'снять отметки «прочитано»', onSelect: () => { clearSaves(S.story.id); toast('Прогресс сброшен'); } },
      { label: 'Удалить историю', icon: MENU_ICONS.trash, danger: true, onSelect: () => makeCtx().removeStory() },
    ],
  });
}

/* ─────────────────────────── превью ─────────────────────────── */

function mountPreview() {
  if (!S) return;
  const host = $('#ed-preview');
  if (!host) return;
  S.stage?.destroy();
  host.innerHTML = '';
  S.stage = new Stage(host, {
    story: S.story,
    start: { sceneId: S.sceneId, stepIndex: S.stepIndex },
    mode: 'edit',
    settings: { ...getSettings(), textSpeed: S.previewAnimated ? 26 : 1 },
    instantFirst: !S.previewAnimated,
    limitToScene: true,
    // предпросмотр в редакторе всегда начинается с выбранного шага
    forceStart: true,
    onPosition: (pos) => {
      const changed = pos.sceneId !== S.sceneId || pos.stepIndex !== S.stepIndex;
      S.sceneId = pos.sceneId;
      S.stepIndex = pos.stepIndex;
      if (changed) {
        if (S.tab !== 'step') { S.tab = 'step'; renderTabs(); }
        renderPanel();
      }
    },
    onVars: () => renderVarsBar(),
    onSceneEnd: () => toast('Конец сцены — добавьте реплику или переход'),
    onChoice: (choice) => {
      const target = resolveTarget(S.story, choice.goto, S.sceneId);
      if (!target) { toast(`Переход «${choice.goto}» не найден`); return; }
      S.tab = 'step';
      renderTabs();
      makeCtx().selectStep(target.sceneId, target.stepIndex);
    },
    onBrokenLink: (ref) => toast(`Переход «${ref}» не найден`),
  });
  S.stage.mount();
  renderVarsBar();
}

/** Текущие значения переменных — чтобы проверять условия прямо в превью. */
function renderVarsBar() {
  const wrap = document.querySelector('.ed-preview-wrap');
  if (!wrap) return;
  const bar = $('#ed-vars-bar');
  const vars = S?.stage?.vars || {};
  const names = Object.keys(vars);
  if (!bar) return;
  if (!names.length) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = 'переменные:';
  bar.append(label);
  for (const name of names) {
    const pill = document.createElement('span');
    pill.className = 'var-pill';
    const strong = document.createElement('b');
    strong.textContent = name;
    pill.append(strong, ` = ${formatValue(vars[name])}`);
    bar.append(pill);
  }
}

function goToCurrent() {
  if (!S?.stage) return;
  S.lastKey = `${S.sceneId}:${S.stepIndex}`;
  // переход по клику в редакторе не должен повторно применять изменения переменных
  S.stage.goTo(S.sceneId, S.stepIndex, { instant: !S.previewAnimated, effects: false, force: true });
}

const schedulePreviewRefresh = debounce(() => refreshPreview({ instant: !S.previewAnimated }), 140);

function refreshPreview({ instant = true } = {}) {
  if (!S?.stage) return;
  S.stage.applySettings({ textSpeed: S.previewAnimated ? 26 : 1 });
  S.stage.refresh({ instant });
}

/* ─────────────────────────── вкладка «Шаг» ─────────────────────────── */

function stepSnippet(step) {
  if (step.text) return step.text.replace(/\n/g, ' ').slice(0, 42);
  if (step.choices?.length) return `выбор: ${step.choices.map((c) => c.text).join(' / ').slice(0, 34)}`;
  if (step.end) return 'конец';
  return 'пусто';
}

export function targetOptions(story, { includeAuto = true, autoLabel = '— дальше автоматически —' } = {}) {
  const options = includeAuto ? [{ value: '', label: autoLabel }] : [];
  for (const scene of story.scenes) {
    options.push({
      label: scene.name,
      group: scene.steps.map((step, i) => ({
        value: `${scene.id}:${step.id}`,
        label: `${i + 1}. ${stepSnippet(step) || '…'}`,
      })),
    });
  }
  return options;
}

function renderStepTab(ctx) {
  const scene = ctx.scene;
  if (!scene) return el('p', { class: 'field-hint', text: 'Нет сцен' });
  const step = ctx.step;
  if (!step) return el('p', { class: 'field-hint', text: 'Нет шагов' });
  const wrap = el('div', { class: 'tab-step' });

  /* навигация */
  wrap.append(el('div', { class: 'step-nav' },
    iconButton(ICONS.up, {
      label: 'Предыдущий шаг',
      onclick: () => ctx.selectStep(scene.id, ctx.stepIndex - 1),
    }),
    el('button', {
      type: 'button',
      class: 'step-counter',
      onclick: () => openStepList(ctx),
    }, el('span', { text: `Шаг ${ctx.stepIndex + 1} / ${scene.steps.length}` }), el('small', { text: scene.name })),
    iconButton(ICONS.down, {
      label: 'Следующий шаг',
      onclick: () => ctx.selectStep(scene.id, ctx.stepIndex + 1),
    }),
    el('span', { class: 'spacer' }),
    iconButton(ICONS.copy, {
      label: 'Дублировать шаг',
      onclick: () => {
        ctx.pushUndo();
        const copy = { ...deepClone(step), id: newStep().id };
        scene.steps.splice(ctx.stepIndex + 1, 0, copy);
        ctx.commit();
        ctx.selectStep(scene.id, ctx.stepIndex + 1);
      },
    }),
    iconButton(ICONS.trash, {
      label: 'Удалить шаг',
      danger: true,
      onclick: async () => {
        if (scene.steps.length === 1) { toast('В сцене должен остаться хотя бы один шаг'); return; }
        ctx.pushUndo();
        scene.steps.splice(ctx.stepIndex, 1);
        ctx.commit();
        ctx.selectStep(scene.id, Math.min(ctx.stepIndex, scene.steps.length - 1));
      },
    }),
  ));

  /* говорящий */
  const speakerOptions = [{ value: '', label: '— рассказчик —' }, ...ctx.story.characters.map((c) => ({ value: c.id, label: c.name }))];
  wrap.append(field('Кто говорит', el('div', { class: 'inline-row' },
    selectControl({
      value: step.speaker || '',
      options: speakerOptions,
      onChange: (value) => {
        ctx.pushUndo();
        step.speaker = value || null;
        if (!value) delete step.spriteOverride;
        ctx.commit();
      },
    }),
    iconButton(ICONS.plus, { label: 'Новый персонаж', onclick: () => promptNewCharacter(ctx, (char) => { step.speaker = char.id; ctx.commit(); }) }),
  )));

  /* текст */
  const counter = el('span', { class: 'char-count', text: `${(step.text || '').length} симв.` });
  const area = textArea({
    value: step.text || '',
    rows: 4,
    placeholder: 'Реплика… *курсив*, **жирный**, Enter — новая строка',
    onInput: (value) => {
      step.text = value;
      counter.textContent = `${value.length} симв.`;
      ctx.patch(() => {}, { preview: true });
    },
    onFocus: () => ctx.pushUndo(),
  });
  wrap.append(el('div', { class: 'field' },
    el('div', { class: 'field-row' }, el('label', { text: 'Текст' }), counter),
    area,
    el('p', { class: 'field-hint', text: 'Пустой текст + варианты = экран выбора без реплики.' }),
  ));

  /* эмоция и эффект */
  const char = step.speaker ? characterById(ctx.story, step.speaker) : null;
  if (char && Object.keys(char.sprites || {}).length) {
    wrap.append(field('Эмоция говорящего', selectControl({
      value: step.spriteOverride || '',
      options: [{ value: '', label: '— как задано в сцене —' }, ...Object.keys(char.sprites).map((k) => ({ value: k, label: k }))],
      onChange: (value) => {
        ctx.pushUndo();
        if (value) step.spriteOverride = value; else delete step.spriteOverride;
        ctx.commit({ panel: false });
      },
    })));
  }

  wrap.append(field('Эффект', selectControl({
    value: step.mood || '',
    options: MOODS.map((m) => ({ value: m, label: MOOD_LABELS[m] })),
    onChange: (value) => {
      ctx.pushUndo();
      step.mood = value;
      ctx.commit({ panel: false });
    },
  })));

  /* кто на сцене с этого шага */
  wrap.append(renderStageCastEditor(ctx, step, scene));

  /* логика: условия и переменные */
  wrap.append(renderLogicEditor(ctx, step));

  /* выборы */
  wrap.append(renderChoicesEditor(ctx, step));

  /* переход */
  wrap.append(section('После реплики',
    switchControl({
      label: 'Конец истории',
      hint: 'показать финальный экран после этой реплики',
      checked: !!step.end,
      onChange: (value) => {
        ctx.pushUndo();
        step.end = value;
        ctx.commit();
      },
    }),
    step.end && step.choices?.length ? el('p', { class: 'field-warn', text: 'У шага есть и выборы, и «конец» — сработают выборы. Уберите одно из двух.' }) : null,
    !step.end ? field('Переход', selectControl({
      value: step.goto || '',
      options: targetOptions(ctx.story),
      onChange: (value) => {
        ctx.pushUndo();
        step.goto = value;
        ctx.commit({ panel: false, preview: false });
      },
    })) : field('Заголовок финала', textInput({
      value: step.endTitle || '',
      placeholder: 'КОНЕЦ · название концовки',
      onInput: (value) => { step.endTitle = value; ctx.patch(() => {}, { preview: false }); },
      onFocus: () => ctx.pushUndo(),
    })),
    el('button', {
      type: 'button',
      class: 'ghost-btn full',
      onclick: () => {
        ctx.pushUndo();
        const next = newStep({ text: '' });
        scene.steps.splice(ctx.stepIndex + 1, 0, next);
        ctx.commit();
        ctx.selectStep(scene.id, ctx.stepIndex + 1);
      },
    }, '+ Добавить реплику ниже'),
  ));

  return wrap;
}

function renderStageCastEditor(ctx, step, scene) {
  const state = stateAt(ctx.story, scene.id, ctx.stepIndex);
  const cast = step.cast ? step.cast : state.cast;
  const box = el('div', { class: 'stage-cast-box' });

  if (!cast.length) {
    box.append(el('p', { class: 'field-hint', text: 'На сцене никого нет.' }));
  }

  for (const entry of cast) {
    const char = characterById(ctx.story, entry.char);
    const thumb = char ? spritePath(ctx.story, entry.char, entry.sprite) : '';
    const spriteKeys = char ? Object.keys(char.sprites || {}) : [];
    box.append(el('div', { class: 'stage-cast-row' },
      el('span', { class: 'cast-thumb' }, thumb ? el('img', { src: resolveUrl(ctx.story, thumb), alt: '' }) : null),
      el('span', { class: 'stage-cast-name', text: char?.name || 'персонаж' }),
      selectControl({
        value: entry.sprite || 'neutral',
        compact: true,
        options: spriteKeys.length ? spriteKeys.map((k) => ({ value: k, label: k })) : [{ value: 'neutral', label: '—' }],
        onChange: (value) => {
          ctx.pushUndo();
          updateCast(ctx, step, cast, (next) => {
            const target = next.find((x) => x.char === entry.char);
            if (target) target.sprite = value;
          }, { panel: false });
        },
      }),
      segmented({
        options: POSITIONS.map((p) => ({ value: p, label: POSITION_SHORT[p] })),
        value: entry.pos || 'center',
        onChange: (value) => {
          ctx.pushUndo();
          updateCast(ctx, step, cast, (next) => {
            const target = next.find((x) => x.char === entry.char);
            if (target) target.pos = value;
          }, { panel: false });
        },
      }),
      iconButton(ICONS.close, {
        label: `${char?.name || 'Персонаж'} уходит`,
        onclick: () => {
          ctx.pushUndo();
          const next = cast.filter((item) => item !== entry).map((item) => ({ ...item }));
          step.cast = next;
          ctx.commit({ panel: true });
        },
      }),
    ));
  }

  const available = ctx.story.characters.filter((c) => !cast.some((e) => e.char === c.id));
  if (available.length) {
    box.append(el('div', { class: 'inline-row' },
      selectControl({
        value: '',
        compact: true,
        options: [{ value: '', label: '— добавить персонажа —' }, ...available.map((c) => ({ value: c.id, label: c.name }))],
        onChange: (value) => {
          if (!value) return;
          ctx.pushUndo();
          const char = characterById(ctx.story, value);
          const next = [...cast.map((item) => ({ ...item })), {
            char: value,
            sprite: Object.keys(char?.sprites || {})[0] || 'neutral',
            pos: cast.length ? 'right' : 'center',
            scale: 1,
            dim: false,
          }];
          step.cast = next;
          ctx.commit({ panel: true });
        },
      }),
    ));
  }

  const isOverridden = !!step.cast;
  return section('Кто на сцене',
    box,
    el('div', { class: 'inline-row' },
      el('span', { class: 'field-hint', style: { flex: '1' }, text: isOverridden ? 'состав изменён с этого шага' : 'наследуется от сцены' }),
      isOverridden ? el('button', {
        type: 'button',
        class: 'text-btn',
        onclick: () => { ctx.pushUndo(); delete step.cast; ctx.commit({ panel: true }); },
      }, 'вернуть как в сцене') : null,
    ),
  );
}

/** Любая правка состава на шаге становится переопределением (step.cast). */
function updateCast(ctx, step, baseCast, change, { panel = true } = {}) {
  const next = baseCast.map((item) => ({ ...item }));
  change(next);
  step.cast = next;
  ctx.commit({ panel });
}

function renderLogicEditor(ctx, step) {
  const story = ctx.story;
  const box = el('div', {});

  box.append(field('Показывать шаг, только если', conditionInput({
    story,
    value: step.if || '',
    placeholder: 'пусто — всегда показывать',
    onFocus: () => ctx.pushUndo(),
    onChange: (value) => {
      if (value.trim()) step.if = value;
      else delete step.if;
      ctx.patch(() => {}, { preview: false });
    },
  }), 'Если условие ложно, шаг пропускается — как будто его нет.'));

  /* знакомство: спросить значение у игрока */
  const askBox = el('div', { class: 'field-col' });
  if (step.ask) {
    const textVars = story.vars.filter((v) => v.type === 'text');
    askBox.append(
      selectControl({
        value: step.ask.var,
        compact: true,
        options: [{ value: '', label: '— переменная —' },
          ...(textVars.length ? textVars : story.vars).map((v) => ({ value: v.name, label: `${v.name} · ${VAR_TYPE_LABELS[v.type]}` }))],
        onChange: (value) => { ctx.pushUndo(); step.ask.var = value; ctx.commit({ panel: true, preview: false }); },
      }),
      textInput({
        value: step.ask.label || '',
        placeholder: 'Как тебя зовут?',
        onFocus: () => ctx.pushUndo(),
        onInput: (value) => { step.ask.label = value; ctx.patch(() => {}, { preview: false }); },
      }),
      textInput({
        value: step.ask.placeholder || '',
        placeholder: 'подсказка в поле (необязательно)',
        onFocus: () => ctx.pushUndo(),
        onInput: (value) => { step.ask.placeholder = value; ctx.patch(() => {}, { preview: false }); },
      }),
      el('div', { class: 'inline-row' },
        textInput({
          value: step.ask.value || '',
          placeholder: 'если игрок промолчит',
          onFocus: () => ctx.pushUndo(),
          onInput: (value) => { step.ask.value = value; ctx.patch(() => {}, { preview: false }); },
        }),
      ),
    );
  }
  box.append(field('Спросить у игрока',
    el('div', { class: 'field-col' },
      switchControl({
        label: step.ask ? 'вопрос включён' : 'спросить значение',
        hint: 'поле ввода поверх сцены, ответ уходит в переменную',
        checked: !!step.ask,
        onChange: (on) => {
          ctx.pushUndo();
          if (!on) delete step.ask;
          else {
            const target = story.vars.find((v) => v.type === 'text') || story.vars[0];
            step.ask = { var: target?.name || '', label: 'Как тебя зовут?', placeholder: '', value: '' };
          }
          ctx.commit({ panel: true, preview: false });
        },
      }),
      askBox,
    ),
    'Игра покажет карточку с полем ввода и не пустит дальше, пока игрок не ответит. Подставляйте ответ в текст как {имя}.',
  ));

  /* изменения переменных */
  const setList = el('div', { class: 'op-list' });
  if (!story.vars.length) {
    setList.append(el('p', { class: 'field-hint', text: 'Сначала объявите переменные: вкладка «История» → «Переменные».' }));
  }
  (step.set || []).forEach((op, index) => {
    const varInfo = story.vars.find((v) => v.name === op.var);
    const row = el('div', { class: 'op-row' },
      selectControl({
        value: op.var,
        compact: true,
        options: [{ value: '', label: '— переменная —' }, ...story.vars.map((v) => ({ value: v.name, label: `${v.name} · ${VAR_TYPE_LABELS[v.type]}` }))],
        onChange: (value) => { ctx.pushUndo(); op.var = value; ctx.commit({ panel: true, preview: false }); },
      }),
      selectControl({
        value: op.op,
        compact: true,
        options: VAR_OPS.filter((o) => varInfo?.type === 'bool' ? ['set', 'toggle'].includes(o) : o !== 'toggle')
          .map((o) => ({ value: o, label: VAR_OP_LABELS[o] })),
        onChange: (value) => { ctx.pushUndo(); op.op = value; ctx.commit({ panel: true, preview: false }); },
      }),
      op.op === 'toggle' ? el('span', { class: 'op-hint', text: 'было ⇄ стало' }) : textInput({
        value: String(op.value ?? ''),
        placeholder: varInfo?.type === 'text' ? 'текст' : 'значение',
        onFocus: () => ctx.pushUndo(),
        onInput: (value) => { op.value = value; ctx.patch(() => {}, { preview: false }); },
      }),
      iconButton(ICONS.trash, {
        label: 'Убрать изменение',
        danger: true,
        onclick: () => { ctx.pushUndo(); step.set.splice(index, 1); if (!step.set.length) delete step.set; ctx.commit(); },
      }),
    );
    setList.append(row);
  });

  box.append(field('Изменить переменные при входе в шаг',
    el('div', { class: 'field-col' },
      setList,
      el('button', {
        type: 'button',
        class: 'text-btn',
        onclick: () => {
          if (!story.vars.length) { toast('Сначала создайте переменную во вкладке «История»'); return; }
          ctx.pushUndo();
          const first = story.vars[0];
          step.set = [...(step.set || []), {
            var: first.name,
            op: first.type === 'bool' ? 'toggle' : 'add',
            value: first.type === 'bool' ? '' : '1',
          }];
          ctx.commit({ panel: true, preview: false });
        },
      }, '+ изменение'),
    ),
    'Применяются при входе на шаг — до того, как реплика появится на экране.',
  ));

  /* условные переходы */
  const gotoList = el('div', { class: 'op-list' });
  (step.gotoIf || []).forEach((rule, index) => {
    gotoList.append(el('div', { class: 'gotoif-row' },
      conditionInput({
        story,
        value: rule.when,
        placeholder: 'если…',
        compact: true,
        onFocus: () => ctx.pushUndo(),
        onChange: (value) => { rule.when = value; ctx.patch(() => {}, { preview: false }); },
      }),
      selectControl({
        value: rule.goto,
        options: targetOptions(story, { includeAuto: false }),
        compact: true,
        onChange: (value) => { ctx.pushUndo(); rule.goto = value; ctx.commit({ panel: false, preview: false }); },
      }),
      iconButton(ICONS.trash, {
        label: 'Убрать переход',
        danger: true,
        onclick: () => { ctx.pushUndo(); step.gotoIf.splice(index, 1); if (!step.gotoIf.length) delete step.gotoIf; ctx.commit(); },
      }),
    ));
  });

  box.append(field('Условные переходы',
    el('div', { class: 'field-col' },
      gotoList,
      el('button', {
        type: 'button',
        class: 'text-btn',
        onclick: () => {
          if (!story.vars.length) { toast('Сначала создайте переменную во вкладке «История»'); return; }
          ctx.pushUndo();
          step.gotoIf = [...(step.gotoIf || []), { when: '', goto: '' }];
          ctx.commit({ panel: true, preview: false });
        },
      }, '+ переход по условию'),
    ),
    'Проверяются по порядку и раньше обычного перехода: первый истинный уводит на свой шаг.',
  ));

  return section('Логика', box);
}

function renderChoicesEditor(ctx, step) {
  const wrap = el('div', { class: 'field choices-editor' },
    el('div', { class: 'field-row' },
      el('label', { text: `Выборы${step.choices?.length ? ` · ${step.choices.length}` : ''}` }),
      el('button', {
        type: 'button',
        class: 'text-btn',
        onclick: () => {
          ctx.pushUndo();
          step.choices = [...(step.choices || []), { text: 'Вариант', goto: '' }];
          ctx.commit();
        },
      }, '+ вариант'),
    ),
  );

  if (!step.choices?.length) {
    wrap.append(el('p', { class: 'field-hint', text: 'Добавьте варианты — игрок сможет выбрать, куда идти дальше.' }));
    return wrap;
  }

  const options = targetOptions(ctx.story, { includeAuto: false });
  step.choices.forEach((choice, i) => {
    const row = el('div', { class: 'choice-row' },
      el('span', { class: 'choice-index', text: String(i + 1) }),
      el('div', { class: 'choice-fields' },
        textInput({
          value: choice.text,
          placeholder: 'Текст варианта',
          onFocus: () => ctx.pushUndo(),
          onInput: (value) => { choice.text = value; ctx.patch(() => {}, { preview: false }); },
        }),
        selectControl({
          value: choice.goto,
          options,
          compact: true,
          onChange: (value) => { ctx.pushUndo(); choice.goto = value; ctx.commit({ panel: false, preview: false }); },
        }),
        el('div', { class: 'choice-cond' },
          el('span', { class: 'choice-cond-label', text: 'показывать если' }),
          conditionInput({
            story: ctx.story,
            value: choice.if || '',
            placeholder: 'пусто — всегда',
            compact: true,
            onFocus: () => ctx.pushUndo(),
            onChange: (value) => {
              if (value.trim()) choice.if = value;
              else delete choice.if;
              ctx.patch(() => {}, { preview: false });
            },
          }),
        ),
      ),
      iconButton(ICONS.trash, {
        label: 'Удалить вариант',
        danger: true,
        onclick: () => { ctx.pushUndo(); step.choices.splice(i, 1); ctx.commit(); },
      }),
    );
    if (!choice.goto) row.classList.add('has-error');
    wrap.append(row);
  });
  return wrap;
}

function openStepList(ctx) {
  const scene = ctx.scene;
  openSheet({
    title: 'Шаги сцены',
    subtitle: `${scene.name} · ${scene.steps.length} ${plural(scene.steps.length, 'шаг', 'шага', 'шагов')}`,
    content: () => {
      const list = el('div', { class: 'step-list' });
      scene.steps.forEach((step, i) => {
        list.append(el('button', {
          type: 'button',
          class: `step-item${i === ctx.stepIndex ? ' is-active' : ''}`,
          onclick: () => {
            ctx.selectStep(scene.id, i);
            document.querySelector('#overlay-root .overlay-backdrop')?.click();
          },
        },
        el('span', { class: 'step-item-index', text: String(i + 1) }),
        el('span', { class: 'step-item-text', text: step.speaker ? `${characterById(ctx.story, step.speaker)?.name || '?'}: ${stepSnippet(step)}` : stepSnippet(step) }),
        ));
      });
      return list;
    },
  });
}

export function promptNewCharacter(ctx, onDone) {
  const input = textInput({ placeholder: 'Имя персонажа', value: '' });
  openSheet({
    title: 'Новый персонаж',
    subtitle: 'Добавим его в список и выберем говорящим',
    content: (close) => el('div', {},
      field('Имя', input),
      el('button', {
        type: 'button',
        class: 'solid-btn',
        style: { width: '100%' },
        onclick: () => {
          const name = input.value.trim();
          if (!name) { toast('Введите имя'); return; }
          ctx.pushUndo();
          const char = ctx.addCharacter(name);
          close();
          onDone?.(char);
        },
      }, 'Создать персонажа'),
    ),
  });
  setTimeout(() => input.focus(), 200);
}

export { stepSnippet };
